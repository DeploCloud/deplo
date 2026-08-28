import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import yaml from "js-yaml";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { decryptSecret } from "../crypto";
import { markDataCopyFailed } from "./data-copy";
import {
  appMounts as appMountsTable,
  appVolumes as appVolumesTable,
  apps as appsTable,
  databases as databasesTable,
  migrationRunItems as itemsTable,
  migrationRuns as runsTable,
  domains as domainsTable,
  envVars as envVarsTable,
  projects as projectsTable,
  servers as serversTable,
  sharedEnvVars as sharedVarsTable,
  sharedEnvVarApps as sharedVarAppsTable,
} from "../db/schema/control-plane";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  TRUNCATE_IDENTITY,
  USER_1,
} from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
  dismissImportedDomains,
} from "./domains";
import { settleProvisioning } from "./backup-test-helpers";
import {
  __setMigrationFetchForTest,
  __resetMigrationFetchForTest,
} from "../migration/transport";
import { __setAgentConnectorForTest } from "../infra/agent-client";
import {
  abandonMigration,
  appendRunItem,
  beginMigration,
  dismissMigrationReport,
  resumableMigration,
  migrationMachines,
  setMigrationMachineAddress,
  drainMigrationSourceUninstalls,
  finishMigration,
  sweepFinishedMigrationMarks,
  undoMigration,
  getMigrationRun,
  importMigrationProject,
  listMigrationRuns,
  revertMigration,
  scanMigrationSource,
  stopMigration,
} from "./migration-import";
import { activeMigrationStream } from "../graphql/types/migration";
import { createProject, renameProject } from "./projects";
import { startApp } from "./apps";
import { startDeployment } from "../deploy/build";
import {
  addServer,
  getServerById,
  removeServer,
  updateServerAddress,
} from "./servers";
import { listEnvironmentsForProject } from "./environments";

/**
 * The Dokploy importer, end to end against pglite with a FAKE Dokploy.
 */

let db: TestDb;
let pg: PGlite;

const URL_BASE = "https://dokploy.acme.test";
const CONNECT = { url: URL_BASE, apiKey: "dk_test_key" };

/* ------------------------------------------------------------------ */
/* The fake instance                                                   */
/* ------------------------------------------------------------------ */

/** Procedure name → the JSON it answers, or a status to fail with. */
type Fixtures = Record<string, unknown | { __status: number; body?: string }>;

let fixtures: Fixtures = {};
/** Every procedure the importer called, in order - the calls are the contract. */
let calls: string[] = [];

/** Swap the compose stack's yaml in the fake instance. */
function setComposeFile(...lines: string[]): void {
  (fixtures["compose.one"] as { composeFile: string }).composeFile =
    lines.join("\n");
}

const DOKPLOY_ICON = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
).toString("base64")}`;

const COMPOSE_WITH_DOKPLOY_NETWORK = [
  "services:",
  "  web:",
  "    image: nginx:1.27",
  "    volumes:",
  // Dokploy's own spelling for a config file next to the stack. The import
  // rewrites it to `./nginx.conf`; the file itself rides in `mounts` below.
  "      - ../files/nginx.conf:/etc/nginx/nginx.conf:ro",
  "    networks:",
  "      - dokploy-network",
  "networks:",
  "  dokploy-network:",
  "    external: true",
].join("\n");

/** Two projects, five services, one of everything worth exercising. */
function defaultFixtures(): Fixtures {
  return {
    "organization.active": { name: "Acme Inc" },
    "server.all": [
      { serverId: "dok-srv-1", name: "eu-1", ipAddress: "203.0.113.10" },
    ],
    "user.all": [
      { role: "owner", user: { email: "owner@acme.test", name: "Owner" } },
      { role: "member", user: { email: "dev@acme.test", name: "Dev" } },
    ],
    "project.all": [
      {
        projectId: "dok-prj-blink",
        name: "Blink",
        env: "SHARED_TOKEN=project-level\n",
        environments: [
          {
            environmentId: "dok-env-prod",
            name: "production",
            isDefault: true,
            env: "ENV_LEVEL=yes\n",
            applications: [
              {
                applicationId: "dok-app-web",
                name: "blink-web",
                serverId: null,
              },
              {
                applicationId: "dok-app-api",
                name: "blink-api",
                serverId: null,
              },
            ],
            compose: [],
            // A real `project.all` gives a database NOTHING but its id - no name,
            // no appName, no serverId. The name comes from `postgres.one`.
            postgres: [{ postgresId: "dok-pg-1" }],
          },
        ],
      },
      {
        projectId: "dok-prj-other",
        name: "Other",
        environments: [
          {
            environmentId: "dok-env-stg",
            name: "staging",
            applications: [],
            compose: [
              { composeId: "dok-cmp-1", name: "other-stack", serverId: null },
            ],
            libsql: [{ libsqlId: "dok-libsql-1", name: "other-libsql" }],
          },
        ],
      },
    ],
    "compose.one": {
      composeId: "dok-cmp-1",
      name: "other-stack",
      appName: "other-stack-xyz",
      sourceType: "raw",
      composeFile: COMPOSE_WITH_DOKPLOY_NETWORK,
      env: "STACK_VAR=1\n",
      domains: [
        {
          domainId: "d-3",
          host: "stack.acme.test",
          serviceName: "web",
          port: 80,
          certificateType: "letsencrypt",
        },
      ],
      mounts: [
        {
          mountId: "m-3",
          type: "file",
          filePath: "nginx.conf",
          content: "server { listen 80; }\n",
          mountPath: "",
        },
      ],
    },
    // The one WRITE the importer makes on the other side: stopping the container
    // that is still holding the port this database wants here.
    "postgres.stop": { ok: true },
    "postgres.one": {
      postgresId: "dok-pg-1",
      name: "blink-db",
      appName: "blink-db-abc",
      dockerImage: "postgres:16",
      databaseName: "blink",
      databaseUser: "blink",
      databasePassword: "Sup3r-secret!pw",
      externalPort: 5432,
      mounts: [],
    },
  };
}

/** The two applications, keyed so one fake `application.one` can serve both. */
const APPLICATIONS: Record<string, unknown> = {
  "dok-app-web": {
    applicationId: "dok-app-web",
    name: "blink-web",
    appName: "blink-web-abc",
    // Dokploy stores an icon inline, exactly as deplo does - a template's logo
    // is downloaded and base64'd on ITS side when the service is created.
    icon: DOKPLOY_ICON,
    sourceType: "github",
    buildType: "nixpacks",
    owner: "acme",
    repository: "blink",
    branch: "main",
    buildPath: "apps/web",
    env:
      "DATABASE_URL=postgres://blink:pw@blink-db-abc:5432/blink\nNODE_ENV=production\n" +
      // The same database, named the way Coolify hands it out: the service's own
      // id, not the container's label.
      "QUEUE_DSN=postgres://blink:pw@dok-pg-1:5432/blink\n" +
      // Names Dokploy's throwaway host - an address that stops existing the
      // moment the app moves.
      "OLD_ADDRESS=https://blink-web-abc.traefik.me/health\n" +
      // The same address again, arriving write-only: `URL` reads as a credential.
      "OLD_ADDRESS_URL=https://blink-web-abc.traefik.me/hook\n" +
      // A value the panel would not hand over. It arrives empty, and its own
      // note says so - the secrets line must not count it as one that landed.
      "LEGACY_TOKEN=\n",
    buildArgs: "NEXT_PUBLIC_SITE=https://blink.acme.test\n",
    memoryLimit: "512m",
    cpuLimit: "0.5",
    autoDeploy: true,
    domains: [
      { domainId: "d-1", host: "blink-web-abc.traefik.me", port: 3000 },
      {
        domainId: "d-2",
        host: "blink.acme.test",
        port: 3000,
        certificateType: "letsencrypt",
      },
    ],
    mounts: [
      {
        mountId: "m-1",
        type: "file",
        filePath: "./config.json",
        content: '{"ok":true}',
        mountPath: "/app/config.json",
      },
      {
        mountId: "m-2",
        type: "volume",
        volumeName: "uploads",
        mountPath: "/app/uploads",
      },
    ],
    ports: [
      { portId: "p-1", publishedPort: 8080, targetPort: 3000, protocol: "tcp" },
    ],
    security: [],
  },
  "dok-app-api": {
    applicationId: "dok-app-api",
    name: "blink-api",
    appName: "blink-api-def",
    sourceType: "docker",
    buildType: "dockerfile",
    dockerImage: "ghcr.io/acme/api:1.4.2",
    env: "PORT=8000\n",
    domains: [],
    mounts: [],
    ports: [],
    security: [],
  },
};

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // A fixed A record: `addDomain` resolves every custom hostname synchronously,
  // and a real lookup would make this suite depend on the network.
  __setDnsResolve4ForTest(async () => ["10.0.0.1"]);
});

after(async () => {
  await settleProvisioning(db);
  __resetDnsResolve4ForTest();
  __resetMigrationFetchForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  // Drain the previous test's floated provisioning before its rows disappear.
  await settleProvisioning(db);
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await db.execute("truncate table migration_runs cascade;");
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // May START a migration and may undo one, but may not delete an app: the
      // revert keeps every delete's own gate, so this is what a leftover looks
      // like without a dead host to fake.
      {
        id: USER_2,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_projects"],
      },
      // An ordinary Member who may migrate: every capability the import needs,
      // and NEITHER of the two orthogonal grants. This is who most of a company
      // is, and the shape the compose gates have to answer correctly.
      {
        id: USER_3,
        teamId: TEAM_A,
        role: "member",
        capabilities: [
          "view",
          "create_projects",
          "create_apps",
          "create_databases",
          "manage_env",
          "manage_domains",
          "write_app_files",
        ],
      },
    ],
  });
  await seedServer(db);
  fixtures = defaultFixtures();
  __setMigrationFetchForTest(routingFetch());
  __setAgentConnectorForTest();
  await db.execute("truncate table databases cascade;");
  calls = [];
});

/** A member of team A who may run a migration and nothing destructive. */
const USER_2 = "user_2";
/** A member who may migrate, holding neither host-volumes nor expose-ports. */
const USER_3 = "user_3";

/** Run as the seeded owner of team A, the way a resolver would. */
function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
}

/** Import one project as the owner. */
function importProject(runId: string, projectId: string) {
  return asOwner(() =>
    importMigrationProject({ ...CONNECT, runId, projectId }),
  );
}

/* ------------------------------------------------------------------ */
/* Scan                                                                */
/* ------------------------------------------------------------------ */

test("scan describes the whole tree without writing anything", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));

  assert.equal(plan.orgName, "Acme Inc");
  assert.deepEqual(
    plan.projects.map((p) => p.name),
    ["Blink", "Other"],
  );
  // Every MACHINE behind that Dokploy, its own host first: whether Deplo has an
  // agent on each is what decides if their data can move at all.
  assert.deepEqual(
    plan.servers.map((s) => s.name),
    ["The Dokploy host", "eu-1"],
  );
  assert.deepEqual(plan.servers[0].sourceId, "");
  // Nothing in this fixture's fleet sits at the fake instance's address.
  assert.deepEqual(
    plan.servers.map((s) => s.deploServerId),
    [null, null],
  );
  assert.deepEqual(
    plan.members.map((m) => m.email),
    ["owner@acme.test", "dev@acme.test"],
  );

  const blink = plan.projects[0];
  assert.equal(blink.exists, false);
  assert.deepEqual(
    blink.environments[0].services.map(
      (s) => `${s.kind}:${s.name}:${s.status}`,
    ),
    [
      "application:blink-web:new",
      "application:blink-api:new",
      "postgres:blink-db:new",
    ],
  );

  // Nothing was created by a scan.
  assert.equal((await db.select().from(appsTable)).length, 0);
  assert.equal((await db.select().from(databasesTable)).length, 0);
});

test("a Dokploy machine Deplo already manages is recognised by its address", async () => {
  const { servers: serversTable } = await import("../db/schema/control-plane");
  const { eq } = await import("drizzle-orm");
  // The seeded server IS the machine the fake Dokploy answers on.
  await db
    .update(serversTable)
    .set({ ip: "dokploy.acme.test", host: "dokploy.acme.test" })
    .where(eq(serversTable.id, SERVER_1));

  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const own = plan.servers.find((s) => s.sourceId === "")!;
  assert.equal(own.ipAddress, "dokploy.acme.test");
  assert.equal(own.deploServerId, SERVER_1);
  // Its remote server is still a machine Deplo has never heard of.
  assert.equal(
    plan.servers.find((s) => s.sourceId === "dok-srv-1")!.deploServerId,
    null,
  );
});

test("a machine already registered as a MIGRATION SOURCE is still recognised", async () => {
  // The regression that would break every volume copy in silence: the source machine
  // is excluded from every picker, so an over-eager filter here would stop matching
  // it - and `resolveSourceServer`, which reads its address the same way, would then
  const { servers: serversTable } = await import("../db/schema/control-plane");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({
      ip: "dokploy.acme.test",
      host: "dokploy.acme.test",
      importOnly: true,
    })
    .where(eq(serversTable.id, SERVER_1));

  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.equal(
    plan.servers.find((s) => s.sourceId === "")!.deploServerId,
    SERVER_1,
  );
});

test("Dokploy on the machine Deplo runs on resolves to the agent already there", async () => {
  // The same-machine case the wizard has a toggle for.
  const { servers: serversTable } = await import("../db/schema/control-plane");
  const { eq } = await import("drizzle-orm");
  const beforeIp = process.env.DEPLO_SERVER_IP;
  const beforeUrl = process.env.DEPLO_PUBLIC_URL;
  // The Deplo host row is registered by IP...
  await db
    .update(serversTable)
    .set({ ip: "10.9.9.9", host: "10.9.9.9" })
    .where(eq(serversTable.id, SERVER_1));
  process.env.DEPLO_SERVER_IP = "10.9.9.9";
  try {
    // ...and the Dokploy URL names the same box by a name nothing on the row
    // mentions. Address matching alone cannot see it.
    delete process.env.DEPLO_PUBLIC_URL;
    const plan = await asOwner(() => scanMigrationSource(CONNECT));
    assert.equal(
      plan.servers.find((s) => s.sourceId === "")!.deploServerId,
      null,
    );

    // Once that name is one of THIS instance's own addresses, the two are the
    // same machine and the agent to use is the one already installed here.
    process.env.DEPLO_PUBLIC_URL = URL_BASE;
    const again = await asOwner(() => scanMigrationSource(CONNECT));
    assert.equal(
      again.servers.find((s) => s.sourceId === "")!.deploServerId,
      SERVER_1,
    );
  } finally {
    if (beforeIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = beforeIp;
    if (beforeUrl === undefined) delete process.env.DEPLO_PUBLIC_URL;
    else process.env.DEPLO_PUBLIC_URL = beforeUrl;
  }
});

test("a placement naming a migration source is refused, on both axes", async () => {
  // It has Docker, so nothing about the machine says "no" - only the role does.
  // Running there would deploy onto the platform being left behind; building
  // there would hand it the app's source and decrypted env.
  const { servers: serversTable } = await import("../db/schema/control-plane");
  const { eq } = await import("drizzle-orm");
  const SOURCE = "srv_source";
  await seedServer(db, SOURCE);
  await db
    .update(serversTable)
    .set({ importOnly: true })
    .where(eq(serversTable.id, SOURCE));

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web", "dok-app-api"],
      placements: [
        { serviceId: "dok-app-web", serverId: SOURCE },
        { serviceId: "dok-app-api", serverId: SERVER_1, buildServerId: SOURCE },
      ],
    }),
  );

  const apps = await db.select().from(appsTable);
  const byName = new Map(apps.map((a) => [a.name, a]));
  // Both land, both on the default, both reported - never silently elsewhere.
  assert.equal(byName.get("blink-web")?.serverId, SERVER_1);
  assert.equal(byName.get("blink-api")?.buildServerId, null);
  assert.equal(
    result.items.filter(
      (i) => i.sourceKind === "server" && i.outcome === "manual",
    ).length,
    2,
    "one line per dropped pick",
  );
});

test("a database the tree gives only an id for is still named, not a crash", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const db = plan.projects[0].environments[0].services.find(
    (s) => s.kind === "postgres",
  )!;
  // `project.all` returns `{postgresId}` and nothing else for a database, which is
  // how "Cannot read properties of undefined (reading 'trim')" happened: the name
  // has to come from the detail row.
  assert.equal(db.name, "blink-db");
  assert.equal(db.targetKind, "database");
});

test("scan marks a libsql database unsupported and never asks for its detail", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const other = plan.projects[1].environments[0].services;
  const libsql = other.find((s) => s.kind === "libsql")!;
  assert.equal(libsql.status, "unsupported");
  assert.equal(libsql.targetKind, null);
  assert.equal(calls.includes("libsql.one"), false);
});

test("scan reports the compose rewrite and the missing git credential up front", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const stack = plan.projects[1].environments[0].services[0];
  assert.match(stack.notes.join(" "), /shared network was removed/);

  const web = plan.projects[0].environments[0].services[0];
  assert.match(web.notes.join(" "), /no credential/);
  assert.match(web.notes.join(" "), /8080->3000/);
  // Both addresses the app answers on are listed - the throwaway one included,
  // because it IS an address today and the review has to say what happens to it:
  // it cannot come across, so Deplo re-hosts its route on one of its own.
  assert.deepEqual(web.domains, [
    "blink-web-abc.traefik.me",
    "blink.acme.test",
  ]);
  assert.match(web.notes.join(" "), /Dokploy's own temporary address/);
});

test("scan warns when a hostname already belongs to another team", async () => {
  await seedApp(db, { id: "prj_other_team", teamId: TEAM_B, slug: "victim" });
  await db.insert(domainsTable).values({
    id: "dom_victim",
    appId: "prj_other_team",
    name: "blink.acme.test",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    entrypoint: "websecure",
    certProvider: "letsencrypt",
    stripPrefix: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const web = plan.projects[0].environments[0].services[0];
  assert.match(web.notes.join(" "), /already routed by another team/);
});

// An imported value naming an address that could not come across points at the
// machine the app just LEFT. Rewriting it is the difference between a migration
// that works and one that looks like it worked.
test("a variable that names the old address is moved to the new one", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const apps = await db.select().from(appsTable);
  const web = apps.find((a) => a.name === "blink-web")!;
  const doms = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  const rehosted = doms.find((d) => d.importedFrom)!;

  const vars = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, web.id));
  const site = vars.find((v) => v.key === "NEXT_PUBLIC_SITE")!;
  // The build arg pointed at blink.acme.test, which this app DID keep, so it is
  // untouched...
  assert.equal(decryptSecret(site.valueEnc), "https://blink.acme.test");
  // ...while the one naming the throwaway address now names what it became.
  const old = vars.find((v) => v.key === "OLD_ADDRESS")!;
  assert.equal(decryptSecret(old.valueEnc), `https://${rehosted.name}/health`);
  // And a WRITE-ONLY one is not left behind: it is the import correcting its own
  // write, so the frozen-secret rule has nothing to protect here.
  const secret = vars.find((v) => v.key === "OLD_ADDRESS_URL")!;
  assert.equal(secret.type, "secret");
  assert.equal(decryptSecret(secret.valueEnc), `https://${rehosted.name}/hook`);
  const run = await asOwner(() => getMigrationRun(runId));
  const said = run!.items
    .filter((i) => i.sourceId === "dok-app-web")
    .map((i) => i.message ?? "")
    .join(" | ");
  assert.match(said, /OLD_ADDRESS, OLD_ADDRESS_URL named the old address/);
});

// The rule, at its hardest: BOTH of this app's addresses are unavailable - one is
// Dokploy's throwaway, the other is a real name another team here already serves.
// It must still arrive answering on two.
test("an app never arrives with fewer addresses than it had", async () => {
  await seedApp(db, { id: "prj_other_team", teamId: TEAM_B, slug: "victim" });
  await db.insert(domainsTable).values({
    id: "dom_victim",
    appId: "prj_other_team",
    name: "blink.acme.test",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    entrypoint: "websecure",
    certProvider: "letsencrypt",
    stripPrefix: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const apps = await db.select().from(appsTable);
  const web = apps.find((a) => a.name === "blink-web")!;
  const doms = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));

  assert.equal(doms.length, 2, "two addresses over there, two here");
  // Neither name came across - one belongs to another team, one to another
  // machine - so both rows are addresses Deplo minted, and both remember why.
  for (const d of doms) assert.match(d.name, /\.nip\.io$/);
  assert.deepEqual(doms.map((d) => d.importedFrom).sort(), [
    "blink-web-abc.traefik.me",
    "blink.acme.test",
  ]);
  // And the routes are intact: the port is what Dokploy served on, not a default.
  for (const d of doms) assert.equal(d.port, 3000);
});

test("scan refuses an address that is not this team's business", async () => {
  await assert.rejects(
    () =>
      asOwner(() =>
        scanMigrationSource({ url: "http://127.0.0.1:3000", apiKey: "k" }),
      ),
    /private or internal address/,
  );
});

// A token nothing accepts is also a panel Deplo cannot identify, so the refusal
// carries BOTH attempts - and each one keeps the panel's own words.
test("scan surfaces the panel's own words when the key is wrong", async () => {
  fixtures["project.all"] = { __status: 401, body: "Invalid API key" };
  await assert.rejects(
    () => asOwner(() => scanMigrationSource(CONNECT)),
    (e: Error) => {
      assert.match(
        e.message,
        /Dokploy request failed \(401\) on project.all: Invalid API key/,
      );
      assert.match(e.message, /could not read/);
      return true;
    },
  );
});

// Naming the platform skips the probe entirely: the wizard already knows after a
// scan, and re-detecting on every later call would be a request per project.
test("a named platform is taken, not re-detected", async () => {
  fixtures["project.all"] = { __status: 401, body: "Invalid API key" };
  await assert.rejects(
    () => asOwner(() => scanMigrationSource({ ...CONNECT, kind: "dokploy" })),
    /Dokploy request failed \(401\) on project.all/,
  );
  // Once, for the scan itself. A detection probe would have asked a second time.
  assert.equal(calls.filter((c) => c === "project.all").length, 1);
});

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

test("a project lands complete: project, environment, apps, variables", async () => {
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, orgName: "Acme Inc" }),
  );

  const result = await importProject(runId, "dok-prj-blink");

  assert.equal(result.projectName, "Blink");
  assert.ok(result.created >= 5, `created ${result.created}`);

  const apps = await db.select().from(appsTable);
  assert.deepEqual(apps.map((a) => a.name).sort(), ["blink-api", "blink-web"]);

  const web = apps.find((a) => a.name === "blink-web")!;
  // Nothing was deployed: the source instance is still serving those hostnames.
  assert.equal(web.status, "idle");
  assert.equal(web.source, "github");
  assert.equal(web.repoRepo, "acme/blink");
  assert.equal(web.repoBranch, "main");

  const api = apps.find((a) => a.name === "blink-api")!;
  assert.equal(api.source, "docker-image");
  assert.equal(api.dockerImage, "ghcr.io/acme/api:1.4.2");

  // Env vars, with the build arg folded in. A connection string arrives
  // write-only; the plain ones stay readable, `NEXT_PUBLIC_*` included.
  const env = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, web.id));
  const byKey = new Map(env.map((e) => [e.key, e]));
  assert.deepEqual([...byKey.keys()].sort(), [
    "DATABASE_URL",
    "LEGACY_TOKEN",
    "NEXT_PUBLIC_SITE",
    "NODE_ENV",
    "OLD_ADDRESS",
    "OLD_ADDRESS_URL",
    "QUEUE_DSN",
  ]);
  assert.equal(byKey.get("DATABASE_URL")!.type, "secret");
  assert.equal(byKey.get("NEXT_PUBLIC_SITE")!.type, "plain");
  assert.equal(byKey.get("NODE_ENV")!.type, "plain");

  // The one that arrived with no value is still a secret ROW, but the note that
  // counts what landed leaves it out: another line already says it came empty.
  assert.equal(byKey.get("LEGACY_TOKEN")!.type, "secret");
  const said = (await asOwner(() => getMigrationRun(runId)))!.items
    .filter((i) => i.sourceId === "dok-app-web")
    .map((i) => i.message ?? "")
    .find((m) => m.includes("arrived as secrets"))!;
  assert.match(said, /^3 variable\(s\) arrived as secrets/);
  assert.doesNotMatch(said, /LEGACY_TOKEN/);

  // The database could not be created against a host with no agent, and that is
  // a REPORT row carrying the host's own words - not a failed import.
  const report = await asOwner(() => getMigrationRun(runId));
  const dbRow = report!.items.find((i) => i.sourceKind === "postgres")!;
  assert.equal(dbRow.outcome, "failed");
  assert.match(dbRow.message!, /not provisioned yet/);
});

// The recovery path: a copy failed, the run ended, and the owner copies the data
// again. Its report lines land on a run that is OVER, and marking there left the
// app frozen behind a migration with nothing left to finish.
test("a line written after the run is over does not freeze the app", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  assert.equal(web.migrationRunId, null, "the finish handed it back");

  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / blink-web",
    sourceKind: "volume",
    sourceName: "blink-web-abc_uploads",
    outcome: "created",
    targetKind: "app",
    targetId: web.id,
    message: "Copied 12 MB (compressed) into deplo-blink-web-uploads.",
  });

  const after = (await db.select().from(appsTable)).find(
    (a) => a.id === web.id,
  )!;
  assert.equal(after.migrationRunId, null, "and it stays handed back");
});

// The verdict has to be about whether the data is there, not about how the last
// attempt went: a panel that stumbles on a retry must not blank out a copy that
// already landed, and then tell the owner their data is missing.
test("a stumble on a retry does not blank out a copy that landed", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  const errorOf = async () =>
    (await db.select().from(appsTable)).find((a) => a.id === web.id)!
      .dataCopyError;

  // Nothing copied yet, so the verdict stands.
  await markDataCopyFailed({ kind: "app", id: web.id }, "the panel stumbled", {
    unlessCopiedIn: runId,
  });
  assert.equal(await errorOf(), "the panel stumbled");

  await db
    .update(appsTable)
    .set({ dataCopyError: "" })
    .where(eq(appsTable.id, web.id));
  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / blink-web",
    sourceKind: "volume",
    sourceName: "blink-web-abc_uploads",
    outcome: "created",
    targetKind: "app",
    targetId: web.id,
    message: "Copied 12 MB (compressed) into deplo-blink-web-uploads.",
  });

  // Now the bytes are in, and a second attempt that reads nothing says nothing.
  await markDataCopyFailed({ kind: "app", id: web.id }, "the panel stumbled", {
    unlessCopiedIn: runId,
  });
  assert.equal(await errorOf(), "");
});

// The heal for a row frozen by an older version: nothing else ever lets it go.
test("the sweep frees a row whose migration is over", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  await db
    .update(appsTable)
    .set({ migrationRunId: runId })
    .where(eq(appsTable.id, web.id));

  await sweepFinishedMigrationMarks();

  const after = (await db.select().from(appsTable)).find(
    (a) => a.id === web.id,
  )!;
  assert.equal(after.migrationRunId, null);
});

test("what a running migration created is nobody else's to touch", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const rows = await db.execute(
    "select id, name, migration_run_id from apps order by name",
  );
  assert.ok(rows.rows.length > 0);
  for (const r of rows.rows)
    assert.equal(
      r.migration_run_id,
      runId,
      `${r.name} must be marked as the run's while it is still running`,
    );
  const projects = await db.execute("select migration_run_id from projects");
  assert.equal(projects.rows[0].migration_run_id, runId);

  // Every door: the deploy pipeline, the compose start, and the container the
  // app lives in are all one refusal, because they all pass the same gate.
  const appId = String(rows.rows[0].id);
  await assert.rejects(
    () => asOwner(() => startApp(appId)),
    /still being brought over by a migration/,
  );
  await assert.rejects(
    () => asOwner(() => startDeployment(appId, { creator: "test" })),
    /still being brought over by a migration/,
  );
  // The container it arrived in, too: deleting the project mid-run would take
  // the apps the migration is still filling with it.
  await assert.rejects(
    () => asOwner(() => renameProject("prc_blink_missing", "x")),
    /not found|still being brought over/i,
  );
});

test("finishing the migration hands everything back", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));

  const rows = await db.execute("select migration_run_id from apps");
  for (const r of rows.rows) assert.equal(r.migration_run_id, null);
  const projects = await db.execute("select migration_run_id from projects");
  for (const r of projects.rows) assert.equal(r.migration_run_id, null);
  const envs = await db.execute("select migration_run_id from environments");
  for (const r of envs.rows) assert.equal(r.migration_run_id, null);
});

test("stopping it hands everything back too, and so does the next run", async () => {
  const first = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(first, "dok-prj-blink");
  await asOwner(() => stopMigration(first));
  let rows = await db.execute("select migration_run_id from apps");
  for (const r of rows.rows) assert.equal(r.migration_run_id, null);

  // And the abandoned-tab case: a run left `running` is closed as Interrupted by
  // the next one, which must let go of everything it was holding.
  const second = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(second, "dok-prj-other");
  await asOwner(() => beginMigration({ url: URL_BASE }));
  rows = await db.execute(
    "select migration_run_id from apps where migration_run_id is not null",
  );
  assert.equal(rows.rows.length, 0);
});

test("an app keeps the icon it had, and one without stays iconless", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  // Carried verbatim: Dokploy already stores the inline form deplo stores, so
  // there is nothing to fetch and nothing to re-encode.
  assert.equal(apps.find((a) => a.name === "blink-web")!.logo, DOKPLOY_ICON);
  // The other app has no icon over there, so it lands with none here rather than
  // borrowing one - favicon detection fills it in on the first deploy.
  assert.equal(apps.find((a) => a.name === "blink-api")!.logo, null);
});

test("an icon deplo would refuse is dropped, and the app still lands", async () => {
  fixtures = defaultFixtures();
  const web = { ...(APPLICATIONS["dok-app-web"] as Record<string, unknown>) };
  // A remote URL: the shape the dashboard's CSP refuses to load at all.
  web.icon = "https://templates.dokploy.com/blueprints/n8n/logo.png";
  __setMigrationFetchForTest(
    routingFetch({ applications: { "dok-app-web": web } }),
  );

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  const row = apps.find((a) => a.name === "blink-web")!;
  assert.equal(row.logo, null);
  // The point: a bad icon costs the icon, never the app.
  assert.equal(row.source, "github");
});

test("the primary domain is the real hostname, not Dokploy's throwaway one", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  const web = apps.find((a) => a.name === "blink-web")!;
  const doms = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  const primary = doms.find((d) => d.isPrimary)!;
  assert.equal(primary.name, "blink.acme.test");
  // The certificate Dokploy had is explicit intent, so it is carried over rather
  // than left for someone to re-tick on every imported app.
  assert.equal(primary.certProvider, "letsencrypt");
  // The throwaway name itself never comes across - it points at the OTHER
  // platform's machine.
  assert.equal(
    doms.some((d) => d.name.endsWith(".traefik.me")),
    false,
  );

  // .but the app still answers on TWO addresses, because it answered on two over
  // there.
  assert.equal(doms.length, 2);
  const rehosted = doms.find((d) => !d.isPrimary)!;
  assert.equal(rehosted.importedFrom, "blink-web-abc.traefik.me");
  assert.match(rehosted.name, /\.nip\.io$/);
  assert.equal(rehosted.port, 3000);
  assert.equal(rehosted.status, "valid");
  assert.equal(rehosted.certProvider, "none");
  // And the report names both ends, so the change is legible without opening the app.
  const report = await asOwner(() => getMigrationRun(runId));
  assert.match(
    report!.items.map((i) => i.message ?? "").join(" "),
    /blink-web-abc\.traefik\.me was Dokploy's own temporary address/,
  );
});

// Dismissing is per app and it is what CLEARS the provenance - the message
// exists for that column, and the import report keeps the permanent record.
test("dismissing the notice clears it for that app only", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  // Finished, because that is when somebody reads this notice: while the run is
  // open its apps are the migration's, and every mutation on them is refused.
  await asOwner(() => finishMigration(runId));
  const apps = await db.select().from(appsTable);
  const web = apps.find((a) => a.name === "blink-web")!;

  const before = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  assert.equal(before.filter((d) => d.importedFrom).length, 1);

  await asOwner(() => dismissImportedDomains(web.id));
  const after = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  assert.equal(after.filter((d) => d.importedFrom).length, 0);
  // The domains themselves are untouched: dismissing hides a message, it does
  // not give up an address.
  assert.deepEqual(
    after.map((d) => d.name).sort(),
    before.map((d) => d.name).sort(),
  );
});

// A compose stack's config file is mounted by the stack's own yaml, so nothing in
// Storage described it and the page showed an empty list for an app that plainly
// had one - while the platform it came from showed the file, with its contents, in
test("a compose stack's config file shows up in Storage", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-other");
  const apps = await db.select().from(appsTable);
  const stack = apps.find((a) => a.name === "other-stack")!;

  // Still the durable copy the agent re-materialises on every bring-up...
  const stored = await db
    .select()
    .from(appMountsTable)
    .where(eq(appMountsTable.appId, stack.id));
  assert.deepEqual(
    stored.map((m) => [m.filePath, m.content]),
    [["nginx.conf", "server { listen 80; }\n"]],
  );

  // ...and now a File entry in Storage, pointing at the same file, at the path
  // the compose binds it to, on the service that binds it.
  const vols = await db
    .select()
    .from(appVolumesTable)
    .where(eq(appVolumesTable.appId, stack.id));
  assert.equal(vols.length, 1);
  assert.equal(vols[0]!.type, "app");
  assert.equal(vols[0]!.projectPath, "nginx.conf");
  assert.equal(vols[0]!.mountPath, "/etc/nginx/nginx.conf");
  assert.equal(vols[0]!.service, "web");
  assert.equal(vols[0]!.readOnly, true);
});

/** Run as the Member who may start a migration but holds no host grant. */
function asMember<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_3, teamId: TEAM_A }, fn);
}

test("a Member migrates a stack whose only host-ish key is env_file", async () => {
  // `env_file: - .env` is the commonest env pattern there is, and it is exactly
  // what the other platform writes for a compose stack. Read as a host escape it
  // made every such stack un-migratable by anybody but an admin.
  setComposeFile(
    "services:",
    "  web:",
    "    image: nginx:1.27",
    "    env_file:",
    "      - .env",
    "    volumes:",
    "      - webdata:/data",
    "volumes:",
    "  webdata:",
  );

  const runId = await asMember(() => beginMigration({ url: URL_BASE }));
  await asMember(() =>
    importMigrationProject({ ...CONNECT, runId, projectId: "dok-prj-other" }),
  );

  const apps = await db.select().from(appsTable);
  const stack = apps.find((a) => a.name === "other-stack");
  assert.ok(stack, apps.map((a) => a.name).join(", "));
  assert.match(stack.compose ?? "", /env_file/);
});

test("a stack a Member may not create says what tripped it, and how", async () => {
  setComposeFile(
    "services:",
    "  ui:",
    "    image: louislam/uptime-kuma:1",
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock:ro",
  );

  const runId = await asMember(() => beginMigration({ url: URL_BASE }));
  await asMember(() =>
    importMigrationProject({ ...CONNECT, runId, projectId: "dok-prj-other" }),
  );

  const rows = await db
    .select()
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));
  const line = rows.find((r) => r.sourceName === "other-stack");
  assert.ok(line, rows.map((r) => r.sourceName).join(", "));
  // Not a crash: a permission decision, with the remedy the single-image path
  // already gives for its dropped bind mount.
  assert.equal(line.outcome, "manual");
  assert.match(String(line.message), /bind mount of a folder on the server/);
  assert.match(String(line.message), /Bind server folders/);
});

test("the compose file arrives with Dokploy's network taken out", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-other");

  const apps = await db.select().from(appsTable);
  const stack = apps.find((a) => a.name === "other-stack")!;
  assert.equal(stack.source, "compose");
  const doc = yaml.load(stack.compose!) as {
    services: Record<string, { networks?: unknown; image?: string }>;
    networks?: unknown;
  };
  assert.equal(doc.networks, undefined);
  assert.equal("networks" in doc.services.web, false);
  assert.match(doc.services.web.image ?? "", /nginx/);

  // Nothing in this stack's variables mentions https, so Deplo's own blueprint
  // rule would have left the domain without a certificate - the letsencrypt here
  // can only have come from Dokploy's own setting.
  const doms = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, stack.id));
  const primary = doms.find((d) => d.isPrimary)!;
  assert.equal(primary.name, "stack.acme.test");
  assert.equal(primary.certProvider, "letsencrypt");
  assert.equal(primary.service, "web");
  assert.equal(primary.port, 80);
});

test("a project's and an environment's own variables become linked shared variables", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const shared = await db.select().from(sharedVarsTable);
  assert.deepEqual(shared.map((s) => s.key).sort(), [
    "ENV_LEVEL",
    "SHARED_TOKEN",
  ]);
  // The LINK is what injects (ADR-0012) - a scope alone would inject nothing.
  const links = await db.select().from(sharedVarAppsTable);
  assert.ok(links.length >= 2, `expected app links, got ${links.length}`);
  // A name that says credential arrives write-only; anything else stays readable.
  assert.equal(shared.find((s) => s.key === "SHARED_TOKEN")!.type, "secret");
  assert.equal(shared.find((s) => s.key === "ENV_LEVEL")!.type, "plain");
});

test("an environment Dokploy calls production reuses the one Deplo already made", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const projectId = (await db.select().from(appsTable))[0].projectId!;
  const envs = await asOwner(() => listEnvironmentsForProject(projectId));
  // Deplo seeds Development / Preview / Production; nothing was added beside them.
  assert.deepEqual(envs.map((e) => e.name).sort(), [
    "Development",
    "Preview",
    "Production",
  ]);
});

test("running the same import again creates nothing", async () => {
  const first = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(first, "dok-prj-blink");
  const appsAfterFirst = (await db.select().from(appsTable)).length;

  const second = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await importProject(second, "dok-prj-blink");

  assert.equal((await db.select().from(appsTable)).length, appsAfterFirst);
  assert.equal(result.created, 0, JSON.stringify(result.items));
  assert.ok(result.skipped >= 4, `skipped ${result.skipped}`);
});

test("one service Dokploy will not return does not stop the others", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  __setMigrationFetchForTest(routingFetch({ failApplication: "dok-app-api" }));
  const result = await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  assert.deepEqual(
    apps.map((a) => a.name),
    ["blink-web"],
  );
  assert.match(
    result.items.find((i) => i.sourceName === "blink-api")!.message!,
    /Dokploy request failed \(500\)/,
  );
  // The app before it, and the database after it, were both still attempted.
  assert.ok(result.created >= 3, `created ${result.created}`);
  assert.ok(result.items.some((i) => i.sourceKind === "postgres"));
});

test("an engine Deplo does not have is settled without asking Dokploy about it", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  calls = [];
  const result = await importProject(runId, "dok-prj-other");

  const row = result.items.find((i) => i.sourceKind === "libsql")!;
  assert.equal(row.outcome, "unsupported");
  assert.match(row.message!, /no libsql engine/);
  // Not a 404 dressed up as a finding: the detail call is never made.
  assert.equal(calls.includes("libsql.one"), false);
});

test("only the picked services come over, and the rest are not even read", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  calls = [];
  const result = await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-api"],
    }),
  );

  const apps = await db.select().from(appsTable);
  assert.deepEqual(
    apps.map((a) => a.name),
    ["blink-api"],
  );
  assert.equal((await db.select().from(databasesTable)).length, 0);
  // Unpicked is not an outcome: nothing about them is in the report, and their
  // detail is never fetched - the filter runs before the expensive call.
  assert.equal(
    result.items.some(
      (i) => i.sourceName === "blink-web" || i.sourceKind === "postgres",
    ),
    false,
  );
  assert.equal(calls.includes("postgres.one"), false);
});

test("each app lands on the server it was placed on, and builds where it was told", async () => {
  const SERVER_2 = "srv_2";
  await seedServer(db, SERVER_2);
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web", "dok-app-api"],
      placements: [
        { serviceId: "dok-app-web", serverId: SERVER_1 },
        {
          serviceId: "dok-app-api",
          serverId: SERVER_2,
          buildServerId: SERVER_1,
        },
      ],
    }),
  );

  const apps = await db.select().from(appsTable);
  const byName = new Map(apps.map((a) => [a.name, a]));
  assert.equal(byName.get("blink-web")?.serverId, SERVER_1);
  assert.equal(byName.get("blink-api")?.serverId, SERVER_2);
  // Automatic unless the caller said otherwise, which is what null means.
  assert.equal(byName.get("blink-web")?.buildServerId, null);
  assert.equal(byName.get("blink-api")?.buildServerId, SERVER_1);
});

test("a placement naming a server this team cannot reach is refused, not used", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web"],
      placements: [
        { serviceId: "dok-app-web", serverId: "srv_from_another_team" },
      ],
    }),
  );

  // It still lands - on the default - and the report says the pick was dropped,
  // because silently deploying somewhere else is the surprise this guards.
  const apps = await db.select().from(appsTable);
  assert.deepEqual(
    apps.map((a) => a.serverId),
    [SERVER_1],
  );
  const line = result.items.find((i) => i.sourceKind === "server")!;
  assert.equal(line.outcome, "manual");
  assert.match(line.message!, /not one this team can deploy to/);
});

test("a build server this team cannot reach falls back to Automatic", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web"],
      placements: [
        {
          serviceId: "dok-app-web",
          serverId: SERVER_1,
          buildServerId: "srv_from_another_team",
        },
      ],
    }),
  );

  const apps = await db.select().from(appsTable);
  assert.equal(apps[0].serverId, SERVER_1);
  assert.equal(apps[0].buildServerId, null);
  assert.match(
    result.items.find((i) => i.sourceKind === "server")!.message!,
    /not one this team can build on/,
  );
});

test("a project that is already here is reused, not duplicated", async () => {
  await asOwner(() => createProject("Blink"));
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await importProject(runId, "dok-prj-blink");

  const projectItem = result.items.find((i) => i.sourceKind === "project")!;
  assert.equal(projectItem.outcome, "skipped");
  assert.match(projectItem.message!, /already here/);
});

/* ------------------------------------------------------------------ */
/* The run and its history                                             */
/* ------------------------------------------------------------------ */

test("the run keeps the report after the tab is gone", async () => {
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, orgName: "Acme Inc" }),
  );
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));

  const runs = await asOwner(() => listMigrationRuns());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].orgName, "Acme Inc");
  assert.ok(runs[0].created > 0);
  assert.ok(runs[0].manual > 0, "the things needing a person are counted");
  assert.ok(runs[0].finishedAt);

  const full = await asOwner(() => getMigrationRun(runId));
  assert.equal(full!.items.length > 0, true);
  // The breadcrumb reads correctly with no source instance to look at.
  assert.ok(full!.items.some((i) => i.path.startsWith("Blink / production /")));
  // The API key is nowhere in the stored run.
  assert.equal(JSON.stringify(full).includes(CONNECT.apiKey), false);
});

/* ------------------------------------------------------------------ */
/* The migration source                                                */
/* ------------------------------------------------------------------ */

/** Register a migration source the way the wizard's Machines step does. */
async function seedSource(name: string, host: string, withAgent = false) {
  const { server } = await asOwner(() =>
    addServer({ name, host, importOnly: true }),
  );
  if (withAgent)
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: `sha256:${server.id}`, agentPort: 9443 })
      .where(eq(serversTable.id, server.id));
  return server.id;
}

test("finishing an import takes Deplo's agent back off the migration source", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.70");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));

  await asOwner(() => finishMigration(runId));

  assert.equal(
    await asOwner(() => getServerById(id)),
    null,
    "the source outlived the migration - someone has to go and remove it by hand",
  );
});

test("data that did not copy KEEPS the source, agent and all", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.71");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / api",
    sourceKind: "volume",
    sourceName: "api-data",
    outcome: "failed",
    message: "the copy failed",
  });

  await asOwner(() => finishMigration(runId));

  assert.ok(
    await asOwner(() => getServerById(id)),
    "the only way back to the bytes was uninstalled",
  );
  const full = await asOwner(() => getMigrationRun(runId));
  assert.match(
    full!.items.find((i) => i.sourceKind === "server")!.message!,
    /still on dokploy-host: data that did not copy/,
  );
});

/** An agent too old to know the uninstall RPC: it never advertises the
 *  capability, so every attempt lands on the same refusal. */
function refusingAgent() {
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({ capabilities: ["self-update"] }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
}

/** The `servers` row's own view of where its uninstall stands. */
async function uninstallState(id: string) {
  const rows = await db.execute(
    `select uninstall_attempts, uninstall_error, uninstall_next_at from servers where id = '${id}'`,
  );
  return rows.rows[0] as {
    uninstall_attempts: number;
    uninstall_error: string;
    uninstall_next_at: string | null;
  };
}

test("a host that will not let go is retried later, and says nothing yet", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.72", true);
  refusingAgent();
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));

  await asOwner(() => finishMigration(runId));

  assert.ok(await asOwner(() => getServerById(id)), "the row must survive");
  const state = await uninstallState(id);
  assert.equal(Number(state.uninstall_attempts), 1);
  assert.ok(state.uninstall_next_at, "a failed attempt schedules the next one");
  // Nothing is asked of anyone while Deplo is still trying: the card on the
  // migration screen reads `uninstallError`, and it is empty until it gives up.
  assert.equal(state.uninstall_error, "");
  const full = await asOwner(() => getMigrationRun(runId));
  assert.equal(
    full!.items.some((i) => i.sourceKind === "server"),
    false,
    "the report must not report a failure that is still being retried",
  );
});

test("after the third try Deplo gives up, and only then asks a person", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.73", true);
  refusingAgent();
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() => finishMigration(runId));

  // The sweep, twice, each time past the row's own next-attempt stamp.
  const later = new Date(Date.now() + 10 * 60_000);
  await drainMigrationSourceUninstalls(later);
  assert.equal(Number((await uninstallState(id)).uninstall_attempts), 2);
  await drainMigrationSourceUninstalls(new Date(later.getTime() + 10 * 60_000));

  const state = await uninstallState(id);
  assert.equal(Number(state.uninstall_attempts), 3);
  assert.equal(state.uninstall_next_at, null, "it stopped trying");
  assert.match(String(state.uninstall_error), /too old to uninstall itself/);
  assert.ok(await asOwner(() => getServerById(id)), "the row must survive");
  // NOW the report says so, and the trail carries it too.
  const full = await asOwner(() => getMigrationRun(runId));
  assert.match(
    full!.items.find((i) => i.sourceKind === "server")!.message!,
    /could not remove its own agent from dokploy-host after 3 tries/,
  );
  const trail = await db.execute(
    "select message from activities where message like '%Could not remove Deplo%'",
  );
  assert.equal(trail.rows.length, 1);
});

test("a source that is not due yet is left alone by the sweep", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.74", true);
  refusingAgent();
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() => finishMigration(runId));

  // A tick that arrives before the ladder's next rung must not burn an attempt:
  // otherwise three ticks in the same minute would spend the whole budget on a
  // host that was simply rebooting.
  await drainMigrationSourceUninstalls(new Date());
  assert.equal(Number((await uninstallState(id)).uninstall_attempts), 1);
});

test("the sweep finishes what a dead process started, with nobody signed in", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.75");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  // The state a control plane that died mid-finish leaves behind: the intent is
  // on the row, nothing has been retried, and there is no request to hang it off.
  await db.execute(
    `update servers set uninstall_run_id = '${runId}', uninstall_next_at = now() - interval '1 minute' where id = '${id}'`,
  );

  // No runWithIdentity: the sweep runs on a timer, and uninstalling is otherwise
  // instance-admin - which is exactly the gate that used to leave agents behind
  // when whoever finished the migration was an ordinary member.
  await drainMigrationSourceUninstalls(new Date());

  assert.equal(
    await asOwner(() => getServerById(id)),
    null,
    "the sweep must be able to finish the job on its own",
  );
});

test("leaving the wizard takes Deplo's agent off the source it registered", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.76");

  assert.equal(await asOwner(() => abandonMigration()), 1);

  assert.equal(
    await asOwner(() => getServerById(id)),
    null,
    "walking away left an agent running on somebody else's machine",
  );
});

test("leaving does not touch the sources a run in flight is reading", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.77");
  // A second tab on the same team, closed while the run is mid-flight: the run
  // copies volumes THROUGH these agents, and it removes them itself when it ends.
  await asOwner(() => beginMigration({ url: URL_BASE }));

  assert.equal(await asOwner(() => abandonMigration()), 0);

  assert.ok(await asOwner(() => getServerById(id)));
});

test("leaving keeps the source that still holds data nothing could copy", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.78");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / api",
    sourceKind: "volume",
    sourceName: "api-data",
    outcome: "failed",
    message: "the copy failed",
  });
  await asOwner(() => finishMigration(runId));

  assert.equal(await asOwner(() => abandonMigration()), 0);

  assert.ok(
    await asOwner(() => getServerById(id)),
    "the only way back to the bytes was uninstalled",
  );
});

// The automatic revert after a failed run is not a person saying "take it all
// out": it took the agent off the machine 90 seconds after installing it, and the
// next attempt could not read a single volume.
test("the revert after a failure keeps the agent the retry needs", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.81");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / api",
    sourceKind: "volume",
    sourceName: "api-data",
    outcome: "failed",
    message: "the copy failed",
  });

  await asOwner(() => undoMigration(runId, { forceSourceRemoval: false }));

  const [source] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, id));
  assert.ok(
    source,
    "the bytes are still over there and this is the way to them",
  );
  assert.equal(source.uninstallNextAt, null, "and nothing is taking it off");
});

test("a stopped run has already handed its sources back", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.79");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() => stopMigration(runId));

  // Nothing left for leaving the page to do: stopping IS the undoing, agents
  // included, so the source is on the uninstall ladder before anybody walks out.
  assert.equal(await asOwner(() => abandonMigration()), 0);
  const [source] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, id));
  assert.ok(
    !source || source.uninstallNextAt !== null || source.uninstallError,
    "stopping must put the source's agent on its way off, not leave it running",
  );
});

/* ------------------------------------------------------------------ */
/* Coming back to a migration                                          */
/* ------------------------------------------------------------------ */

test("the wizard opens on the run you left, until you close its report", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));

  // Leaving the page and coming back is this read: the run, not an empty form.
  const open = await asOwner(() => resumableMigration());
  assert.equal(open?.id, runId);
  assert.equal(open?.status, "running");
  assert.equal(open?.reportSeenAt, null);

  await asOwner(() => finishMigration(runId));
  const finished = await asOwner(() => resumableMigration());
  assert.equal(
    finished?.id,
    runId,
    "a run that ended while you were away still owes you its report",
  );

  await asOwner(() => dismissMigrationReport(runId));
  assert.equal(
    await asOwner(() => resumableMigration()),
    null,
    "the wizard must be startable again once the report is closed",
  );
});

test("a teammate opens on the run in flight, but not on somebody else's report", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await db.execute(
    `update migration_runs set actor_user_id = 'someone_else' where id = '${runId}'`,
  );

  // Running: it is the TEAM's, and everybody who may open the page gets the same
  // panel on it - the same Stop included, which is what the server has always
  // allowed. A screen that hides a button the server would honour is a lie.
  assert.equal(
    (await asOwner(() => resumableMigration()))?.id,
    runId,
    "a run in flight must reach every member of the team, not only its actor",
  );

  // Ended: now it is one person's verdict to read and close. A teammate would
  // otherwise be handed somebody else's report to dismiss - History is where
  // they read it.
  await db.execute(
    `update migration_runs set status = 'done' where id = '${runId}'`,
  );
  assert.equal(
    await asOwner(() => resumableMigration()),
    null,
    "a finished run belongs to whoever started it until they close its report",
  );

  await assert.rejects(() =>
    runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
      dismissMigrationReport(runId),
    ),
  );
});

test("undoing a migration is being done with it", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  await asOwner(() => revertMigration(runId));

  assert.equal(
    await asOwner(() => resumableMigration()),
    null,
    "the wizard would open on a run whose work has just been taken back out",
  );
});

test("a run left open by a closed tab is closed as interrupted by the next one", async () => {
  const abandoned = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() => beginMigration({ url: URL_BASE }));

  const runs = await asOwner(() => listMigrationRuns());
  const old = runs.find((r) => r.id === abandoned)!;
  assert.equal(old.status, "failed");
  assert.equal(old.error, "Interrupted");
  assert.equal(runs.filter((r) => r.status === "running").length, 1);
});

test("an import run belongs to its team", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
        importMigrationProject({
          ...CONNECT,
          runId,
          projectId: "dok-prj-blink",
        }),
      ),
    /scoped to a team the user no longer belongs to|does not belong to this team/,
  );
});

/* ------------------------------------------------------------------ */
/* The fake's request router                                           */
/* ------------------------------------------------------------------ */

/**
 * A fetch that answers `application.one` by the id in the query string, so one
 * fake can serve a project with several applications, and can be told to fail
 * exactly one of them.
 */
function routingFetch(
  opts: {
    failApplication?: string;
    /** Per-id overrides for `application.one`, so one test can change a single
     *  field of an app without editing the shared fixture. */
    applications?: Record<string, unknown>;
  } = {},
) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    // A Dokploy serves neither Coolify's `/api/v1` nor its healthcheck, so the
    // detection probe gets what a real one gives it.
    if (/^\/api\/(v1|health)\b/.test(url.pathname))
      return new Response("not found", { status: 404 });

    const procedure = url.pathname.replace(/^\/api\//, "");
    calls.push(procedure);
    assert.equal(new Headers(init?.headers).get("x-api-key"), CONNECT.apiKey);

    if (procedure === "application.one") {
      const id = url.searchParams.get("applicationId") ?? "";
      if (id === opts.failApplication)
        return new Response("upstream exploded", { status: 500 });
      const body = opts.applications?.[id] ?? APPLICATIONS[id];
      if (!body) return new Response("not found", { status: 404 });
      return json(body);
    }
    const hit = fixtures[procedure];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (hit && typeof hit === "object" && "__status" in hit) {
      const fail = hit as { __status: number; body?: string };
      return new Response(fail.body ?? "boom", { status: fail.__status });
    }
    return json(hit);
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/* ------------------------------------------------------------------ */
/* A database's host port                                              */
/* ------------------------------------------------------------------ */

/**
 * The port a database publishes over there is the port it should publish here, and
 * for a long time it simply did not arrive.
 */

/** Give SERVER_1 an agent, and say which host ports are already taken on it. */
async function provisionServer1(taken: number[] = []): Promise<{
  probed: number[];
}> {
  const { servers: serversTable } = await import("../db/schema/control-plane");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({
      agentPort: 9443,
      agentCertFingerprint: "sha256:pinned",
      agentCertPem: "-----BEGIN CERTIFICATE-----",
      agentVersion: "1.27.0",
    })
    .where(eq(serversTable.id, SERVER_1));
  const held = new Set(taken);
  const probed: number[] = [];
  __setAgentConnectorForTest(
    async () =>
      ({
        checkPort: async (port: number) => {
          probed.push(port);
          // The source lets go the moment it is stopped, which is the whole point
          // of stopping it before asking again.
          return {
            available: !held.has(port) || calls.includes("postgres.stop"),
            reason: "",
          };
        },
        reroute: async () => ({ ok: true, error: "" }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
  return { probed };
}

/** The publish-ports grant, which is a per-user flag and not a capability. */
async function grantExposePorts(): Promise<void> {
  await db.execute(
    `update users set can_expose_ports = true where id = '${USER_1}'`,
  );
}

const dbRowOf = async (name: string) =>
  (await db.select().from(databasesTable)).find((d) => d.name === name);

const notesOf = async (runId: string) =>
  (await asOwner(() => getMigrationRun(runId)))!.items
    .filter((i) => i.sourceKind === "postgres")
    .map((i) => i.message ?? "")
    .join(" | ");

test("a database keeps the host port it published on Dokploy", async () => {
  await provisionServer1();
  await grantExposePorts();
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  // Provisioning is floated, and the runner blames the test that started work
  // still in flight when it returns - so every one of these drains its own.
  await settleProvisioning(db);

  const row = await dbRowOf("blink-db");
  assert.equal(row?.exposedPublicly, true);
  assert.equal(row?.exposedPort, 5432);
  // Exposed means the connection string is the one that WORKS from outside.
  assert.ok(row!.connectionStringEnc.length > 0);
});

// Coolify gives an app the database's UUID as its hostname, Dokploy the
// container's label. Both have to be renamed, or the app arrives pointing at a
// host that does not exist here - and says nothing about it.
test("a database is renamed whether the app named it by host or by id", async () => {
  await provisionServer1();
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  const host = (await dbRowOf("blink-db"))!.host;
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  const vars = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, web.id));
  const value = (key: string) =>
    decryptSecret(vars.find((v) => v.key === key)!.valueEnc);

  assert.equal(value("DATABASE_URL"), `postgres://blink:pw@${host}:5432/blink`);
  assert.equal(value("QUEUE_DSN"), `postgres://blink:pw@${host}:5432/blink`);
});

test("the review can move that port, or refuse to publish it at all", async () => {
  await provisionServer1();
  await grantExposePorts();

  const runA = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId: runA,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-pg-1"],
      placements: [
        { serviceId: "dok-pg-1", serverId: SERVER_1, exposedPort: 25432 },
      ],
    }),
  );
  await settleProvisioning(db);
  const moved = await dbRowOf("blink-db");
  assert.equal(moved?.exposedPort, 25432);
  assert.match(await notesOf(runA), /instead of 5432/);

  await db.execute("truncate table databases cascade;");
  const runB = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId: runB,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-pg-1"],
      placements: [
        { serviceId: "dok-pg-1", serverId: SERVER_1, exposedPort: null },
      ],
    }),
  );
  await settleProvisioning(db);
  const quiet = await dbRowOf("blink-db");
  assert.equal(quiet?.exposedPublicly, false);
  assert.equal(quiet?.exposedPort, null);
  assert.match(await notesOf(runB), /not published, as chosen/);
});

test("the source holding the port is not a reason to drop it - it is stopped", async () => {
  // 5432 is taken on the target host, and the thing holding it is the Dokploy
  // container being imported: same machine, so stopping it frees the port.
  const { servers: serversTable } = await import("../db/schema/control-plane");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({ ip: "dokploy.acme.test", host: "dokploy.acme.test" })
    .where(eq(serversTable.id, SERVER_1));
  await provisionServer1([5432]);
  await grantExposePorts();

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  await settleProvisioning(db);
  assert.equal(
    calls.filter((p) => p === "postgres.stop").length,
    1,
    "the source was stopped, once",
  );
  const row = await dbRowOf("blink-db");
  assert.equal(row?.exposedPublicly, true, "and the port came over anyway");
  assert.equal(row?.exposedPort, 5432);
});

test("without the publish-ports grant the port is dropped, and the report says why", async () => {
  await provisionServer1();
  // An instance admin holds every grant implicitly, and the seeded owner is one -
  // so taking the grant away means taking that away too.
  await db.execute(
    `update users set is_instance_admin = false, can_expose_ports = false
       where id = '${USER_1}'`,
  );
  // The plan still SAYS what the source publishes - that is a fact about the other
  // platform, and the review needs it to count how many databases are about to lose
  // theirs - but the import says the true reason rather than blaming the old
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const planned = plan.projects
    .flatMap((p) => p.environments.flatMap((e) => e.services))
    .find((s) => s.sourceId === "dok-pg-1")!;
  assert.equal(planned.exposedPort, 5432);

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);
  const row = await dbRowOf("blink-db");
  assert.equal(row?.exposedPublicly, false);
  assert.match(await notesOf(runId), /permission to publish ports/);
});

/* ------------------------------------------------------------------ */
/* Undo                                                                */
/* ------------------------------------------------------------------ */

/**
 * The half-finished migration, taken back out.
 */

test("a revert removes what the run created", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);
  assert.ok(
    (await db.select().from(appsTable)).length > 0,
    "nothing was imported",
  );

  const result = await asOwner(() => revertMigration(runId));
  await settleProvisioning(db);

  assert.ok(result.apps > 0, `removed ${result.apps} apps`);
  assert.equal(result.projects, 1, "the project it created is gone too");
  assert.deepEqual(result.failed, []);
  assert.equal((await db.select().from(appsTable)).length, 0);
  assert.equal((await db.select().from(projectsTable)).length, 0);
  // The team-level variables it added go too - otherwise "reverted" leaves a
  // page of shared variables nobody asked for.
  assert.equal((await db.select().from(sharedVarsTable)).length, 0);

  // The run stays in History, saying what it now is.
  const rows = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  assert.equal(rows[0].status, "reverted");
});

test("what a revert could not remove is written into the run's log", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  // Undone by somebody who may start a migration but may not delete an app.
  // Every delete keeps its own gate, so what they may not remove comes back as
  // a leftover rather than as a thrown error.
  const result = await runWithIdentity({ userId: USER_2, teamId: TEAM_A }, () =>
    revertMigration(runId),
  );
  await settleProvisioning(db);

  assert.ok(
    result.failed.length > 0,
    "nothing failed, so this fixture proves nothing",
  );
  assert.equal(
    result.apps,
    0,
    "an app went out under a capability that bars it",
  );

  // The reason used to be appended to a client-side array that the same
  // function cleared three lines later, so "this is still here, and here is
  // why" reached nobody at all.
  const report = await asOwner(() => getMigrationRun(runId));
  const leftovers = report!.items.filter((i) => i.sourceKind === "undo");
  assert.equal(leftovers.length, result.failed.length);
  assert.ok(
    leftovers.every((i) => i.outcome === "failed" && i.message),
    "a leftover with no reason is not a log line",
  );
});

test("a revert never touches a project the run only reused", async () => {
  // Same name Dokploy uses, created here first: `ensureProject` reuses it and
  // records `skipped`, so it is not the run's to take away.
  const mine = await asOwner(() => createProject("Blink"));
  await seedApp(db, { id: "prj_keep", projectId: mine.id });

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  const result = await asOwner(() => revertMigration(runId));
  await settleProvisioning(db);

  assert.equal(result.projects, 0, "it deleted a project it did not create");
  const projects = await db.select().from(projectsTable);
  assert.deepEqual(
    projects.map((p) => p.id),
    [mine.id],
  );
  // The app that was already in it is still in it.
  const apps = await db.select().from(appsTable);
  assert.deepEqual(
    apps.map((a) => a.id),
    ["prj_keep"],
  );
});

test("a revert of somebody else's run is not found", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
        revertMigration(runId),
      ),
    /no longer belongs|not found|permission/i,
  );
  // And nothing moved.
  assert.ok((await db.select().from(appsTable)).length > 0);
});

test("stopping a run undoes it whole: what it made here, and the agent over there", async () => {
  // The machine the migration reads from, registered the way the install step
  // registers it.
  const SOURCE = "srv_stop_source";
  await seedServer(db, SOURCE);
  await db
    .update(serversTable)
    .set({ importOnly: true })
    .where(eq(serversTable.id, SOURCE));

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);
  const landed = await db.select().from(appsTable);
  assert.ok(landed.length > 0, "the import has to have made something to undo");

  await asOwner(() => stopMigration(runId));

  // There is no half-migrated state to keep: a stop lands mid-copy far more
  // often than not, and a volume 60% across is not 60% of an app.
  const rows = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  assert.equal(rows[0].status, "reverted");
  assert.equal(
    (await db.select().from(appsTable)).length,
    0,
    "everything the run created has to be gone",
  );
  const [source] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, SOURCE));
  assert.ok(
    !source || source.uninstallNextAt !== null || source.uninstallError,
    "the agent Deplo put on the source is on its way back off",
  );

  // Idempotent: a second call finds nothing left to delete.
  await asOwner(() => stopMigration(runId));
  const again = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId));
  assert.equal(again[0].status, "reverted");
});

/* ------------------------------------------------------------------ */
/* The header chip                                                     */
/* ------------------------------------------------------------------ */

test("the live stream follows a run from start to finish, team-scoped", async () => {
  // No runWithIdentity: it is read from an SSE tick, where cookies are gone.
  const gen = activeMigrationStream(TEAM_A);
  assert.equal(
    (await gen.next()).value,
    null,
    "nothing running, nothing to say",
  );

  const pending = gen.next();
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, orgName: "Acme Inc" }),
  );
  const started = await pending;
  assert.equal(started.value?.id, runId);
  assert.equal(started.value?.orgName, "Acme Inc");
  // A run nobody has picked up yet says so, and that is the whole point of the field:
  // the row says `running` from the moment it is opened, whether or not any control
  // plane is driving it, and the panel used to report "Migration in progress" over
  assert.equal(
    started.value?.heartbeatAt,
    null,
    "a run no runner has claimed must not look like one in flight",
  );

  // Another team's chip never lights up for it.
  assert.equal((await activeMigrationStream(TEAM_B).next()).value, null);

  const ending = gen.next();
  await asOwner(() => stopMigration(runId));
  assert.equal((await ending).value, null, "a stopped run is not in progress");

  await gen.return(undefined as never);
});

/* ------------------------------------------------------------------ */
/* Where the machine is, and where we dial it                          */
/* ------------------------------------------------------------------ */

test("a corrected dial address keeps the machine recognisable by the one it came from", async () => {
  // A Dokploy panel behind Cloudflare (or any reverse proxy) answers on the proxy's
  // address, so the row the wizard registers is unreachable and has to be corrected.
  const panelHost = new URL(URL_BASE).hostname;
  const credential = {
    kind: "dokploy" as const,
    baseUrl: URL_BASE,
    apiKey: CONNECT.apiKey,
  };
  const added = await asOwner(() =>
    addServer({ name: "dokploy-host", host: panelHost, importOnly: true }),
  );

  const before = await asOwner(() => migrationMachines(credential, TEAM_A));
  assert.equal(before[0]?.sourceId, "", "the Dokploy host itself comes first");
  assert.equal(before[0]?.deploServerId, added.server.id);

  await asOwner(() =>
    updateServerAddress({
      id: added.server.id,
      address: "203.0.113.7",
      keepHost: true,
    }),
  );

  const server = await asOwner(() => getServerById(added.server.id));
  assert.equal(server?.ip, "203.0.113.7", "we dial the machine");
  assert.equal(server?.host, panelHost, "we remember where it came from");

  const after = await asOwner(() => migrationMachines(credential, TEAM_A));
  assert.equal(
    after[0]?.deploServerId,
    added.server.id,
    "still the same machine, not a second registration",
  );
});

test("a corrected address outlives the server row it was made on", async () => {
  // The cycle this closes, seen four times in one evening: correct the address,
  // migrate, revert - and the source row is removed, on purpose, because a migration
  // source is not a server anyone keeps.
  const panelHost = new URL(URL_BASE).hostname;
  const credential = {
    kind: "dokploy" as const,
    baseUrl: URL_BASE,
    apiKey: CONNECT.apiKey,
  };
  const added = await asOwner(() =>
    addServer({ name: "dokploy-host", host: panelHost, importOnly: true }),
  );

  await asOwner(() =>
    setMigrationMachineAddress({
      sourceUrl: URL_BASE,
      sourceId: "",
      serverId: added.server.id,
      address: "203.0.113.7",
    }),
  );

  // Still one machine, still matched: `keepHost` left the panel name on the row.
  const during = await asOwner(() => migrationMachines(credential, TEAM_A));
  assert.equal(during[0]?.deploServerId, added.server.id);
  assert.equal(during[0]?.ipAddress, "203.0.113.7");

  // Now the migration ends and the source goes, which is the bug in one line:
  // everything Deplo knew about that machine used to go with it.
  await asOwner(() => removeServer(added.server.id));

  const after = await asOwner(() => migrationMachines(credential, TEAM_A));
  assert.equal(after[0]?.sourceId, "");
  assert.equal(
    after[0]?.ipAddress,
    "203.0.113.7",
    "the next attempt must register it where it actually is",
  );
  assert.equal(
    after[0]?.deploServerId,
    null,
    "and register it, since it is gone",
  );
});

test("a remembered address belongs to one team and one panel", async () => {
  const added = await asOwner(() =>
    addServer({
      name: "dokploy-host",
      host: new URL(URL_BASE).hostname,
      importOnly: true,
    }),
  );
  await asOwner(() =>
    setMigrationMachineAddress({
      sourceUrl: URL_BASE,
      sourceId: "",
      serverId: added.server.id,
      address: "203.0.113.7",
    }),
  );
  // A DIFFERENT Dokploy, same team: its host is its own machine, and borrowing
  // this address would point a migration at the wrong box.
  const other = await asOwner(() =>
    migrationMachines(
      {
        kind: "dokploy" as const,
        baseUrl: "https://dokploy.other.test",
        apiKey: "k",
      },
      TEAM_A,
    ),
  );
  assert.equal(other[0]?.ipAddress, "dokploy.other.test");
});

/* ------------------------------------------------------------------ */
/* Which platform a run read                                          */
/* ------------------------------------------------------------------ */

test("a scan reports which product answered", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.equal(plan.platform, "dokploy");
});

test("a run records the platform, and defaults to the older one", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const rows = await asOwner(() => listMigrationRuns());
  assert.equal(rows.find((r) => r.id === runId)?.platform, "dokploy");
});

test("a run opened as Coolify stays Coolify", async () => {
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, kind: "coolify" }),
  );
  const rows = await asOwner(() => listMigrationRuns());
  assert.equal(rows.find((r) => r.id === runId)?.platform, "coolify");
});

// The row is what a resume reads hours later. Re-detecting then could answer
// differently and point the data cutover at the wrong API.
test("the platform is on the row, not derived from the address", async () => {
  await asOwner(() => beginMigration({ url: URL_BASE, kind: "coolify" }));
  const [row] = (
    await db.execute(
      "select platform from migration_runs order by seq desc limit 1",
    )
  ).rows as { platform: string }[];
  assert.equal(row.platform, "coolify");
});
