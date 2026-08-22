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
import {
  apps as appsTable,
  databases as databasesTable,
  dokployImports as runsTable,
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
import { __setDnsResolve4ForTest, __resetDnsResolve4ForTest } from "./domains";
import { settleProvisioning } from "./backup-test-helpers";
import {
  __setDokployFetchForTest,
  __resetDokployFetchForTest,
} from "../dokploy/client";
import { __setAgentConnectorForTest } from "../infra/agent-client";
import {
  appendRunItem,
  beginDokployImport,
  finishDokployImport,
  getDokployImport,
  importDokployProject,
  listDokployImports,
  revertDokployImport,
  scanDokploy,
  stopDokployImport,
} from "./dokploy-import";
import { createProject } from "./projects";
import { addServer, getServerById } from "./servers";
import { listEnvironmentsForProject } from "./environments";

/**
 * The Dokploy importer, end to end against pglite with a FAKE Dokploy.
 *
 * The fake is the whole point: the API's shapes are pinned by
 * `lib/dokploy/map.test.ts` against recorded rows, and what this file proves is
 * the other half — that a plausible organization lands complete, that a second
 * run creates nothing, that one broken service does not take the rest down, and
 * that the things which cannot come across end up IN THE REPORT rather than
 * nowhere.
 *
 * The seeded server deliberately has NO agent record, which is this repo's only
 * seam for the agent (there is no `connectAgent` mock — the same note is in
 * `databases.test.ts`). A database therefore lands as a `failed` report row
 * reading "not provisioned yet", which is also the real behaviour when someone
 * imports onto a host whose agent is not up: what matters here is that the rest
 * of the project still arrives. The database MAPPING is covered pure in
 * `lib/dokploy/map.test.ts`.
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
/** Every procedure the importer called, in order — the calls are the contract. */
let calls: string[] = [];

const COMPOSE_WITH_DOKPLOY_NETWORK = [
  "services:",
  "  web:",
  "    image: nginx:1.27",
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
              { applicationId: "dok-app-web", name: "blink-web", serverId: null },
              { applicationId: "dok-app-api", name: "blink-api", serverId: null },
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
            compose: [{ composeId: "dok-cmp-1", name: "other-stack", serverId: null }],
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
      mounts: [],
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
    sourceType: "github",
    buildType: "nixpacks",
    owner: "acme",
    repository: "blink",
    branch: "main",
    buildPath: "apps/web",
    env: "DATABASE_URL=postgres://blink:pw@blink-db-abc:5432/blink\nNODE_ENV=production\n",
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
    ports: [{ portId: "p-1", publishedPort: 8080, targetPort: 3000, protocol: "tcp" }],
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
  __resetDokployFetchForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  // Drain the previous test's floated provisioning before its rows disappear.
  await settleProvisioning(db);
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await db.execute("truncate table dokploy_imports cascade;");
  await seedIdentity(db);
  await seedServer(db);
  fixtures = defaultFixtures();
  __setDokployFetchForTest(routingFetch());
  __setAgentConnectorForTest();
  await db.execute("truncate table databases cascade;");
  calls = [];
});

/** Run as the seeded owner of team A, the way a resolver would. */
function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
}

/** Import one project as the owner. */
function importProject(runId: string, projectId: string) {
  return asOwner(() => importDokployProject({ ...CONNECT, runId, projectId }));
}

/* ------------------------------------------------------------------ */
/* Scan                                                                */
/* ------------------------------------------------------------------ */

test("scan describes the whole tree without writing anything", async () => {
  const plan = await asOwner(() => scanDokploy(CONNECT));

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
    blink.environments[0].services.map((s) => `${s.kind}:${s.name}:${s.status}`),
    ["application:blink-web:new", "application:blink-api:new", "postgres:blink-db:new"],
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

  const plan = await asOwner(() => scanDokploy(CONNECT));
  const own = plan.servers.find((s) => s.sourceId === "")!;
  assert.equal(own.ipAddress, "dokploy.acme.test");
  assert.equal(own.deploServerId, SERVER_1);
  // Its remote server is still a machine Deplo has never heard of.
  assert.equal(plan.servers.find((s) => s.sourceId === "dok-srv-1")!.deploServerId, null);
});

test("a machine already registered as a MIGRATION SOURCE is still recognised", async () => {
  // The regression that would break every volume copy in silence: the source
  // machine is excluded from every picker, so an over-eager filter here would
  // stop matching it - and `resolveSourceServer`, which reads its address the
  // same way, would then answer "no agent on that host" on the second pass.
  const { servers: serversTable } = await import("../db/schema/control-plane");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({ ip: "dokploy.acme.test", host: "dokploy.acme.test", importOnly: true })
    .where(eq(serversTable.id, SERVER_1));

  const plan = await asOwner(() => scanDokploy(CONNECT));
  assert.equal(plan.servers.find((s) => s.sourceId === "")!.deploServerId, SERVER_1);
});

test("Dokploy on the machine Deplo runs on resolves to the agent already there", async () => {
  // The same-machine case the wizard has a toggle for. The addresses rarely match
  // in FORM - a panel hostname in the URL, an IP on the row - so this used to read
  // as an unknown machine, and registering it again is now refused (a second row
  // for one host would re-bootstrap the fleet's own agent as a migration source).
  // The agent that can read those disks is already installed.
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
    const plan = await asOwner(() => scanDokploy(CONNECT));
    assert.equal(plan.servers.find((s) => s.sourceId === "")!.deploServerId, null);

    // Once that name is one of THIS instance's own addresses, the two are the
    // same machine and the agent to use is the one already installed here.
    process.env.DEPLO_PUBLIC_URL = URL_BASE;
    const again = await asOwner(() => scanDokploy(CONNECT));
    assert.equal(again.servers.find((s) => s.sourceId === "")!.deploServerId, SERVER_1);
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

  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  const result = await asOwner(() =>
    importDokployProject({
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
    result.items.filter((i) => i.sourceKind === "server" && i.outcome === "manual").length,
    2,
    "one line per dropped pick",
  );
});

test("a database the tree gives only an id for is still named, not a crash", async () => {
  const plan = await asOwner(() => scanDokploy(CONNECT));
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
  const plan = await asOwner(() => scanDokploy(CONNECT));
  const other = plan.projects[1].environments[0].services;
  const libsql = other.find((s) => s.kind === "libsql")!;
  assert.equal(libsql.status, "unsupported");
  assert.equal(libsql.targetKind, null);
  assert.equal(calls.includes("libsql.one"), false);
});

test("scan reports the compose rewrite and the missing git credential up front", async () => {
  const plan = await asOwner(() => scanDokploy(CONNECT));
  const stack = plan.projects[1].environments[0].services[0];
  assert.match(stack.notes.join(" "), /shared network was removed/);

  const web = plan.projects[0].environments[0].services[0];
  assert.match(web.notes.join(" "), /no credential/);
  assert.match(web.notes.join(" "), /8080->3000/);
  // The throwaway traefik.me host never appears as something to import.
  assert.deepEqual(web.domains, ["blink.acme.test"]);
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

  const plan = await asOwner(() => scanDokploy(CONNECT));
  const web = plan.projects[0].environments[0].services[0];
  assert.match(web.notes.join(" "), /already routed by another team/);
});

test("scan refuses an address that is not this team's business", async () => {
  await assert.rejects(
    () => asOwner(() => scanDokploy({ url: "http://127.0.0.1:3000", apiKey: "k" })),
    /private or internal address/,
  );
});

test("scan surfaces Dokploy's own words when the key is wrong", async () => {
  fixtures["project.all"] = { __status: 401, body: "Invalid API key" };
  await assert.rejects(
    () => asOwner(() => scanDokploy(CONNECT)),
    /Dokploy request failed \(401\) on project.all: Invalid API key/,
  );
});

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

test("a project lands complete: project, environment, apps, variables", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE, orgName: "Acme Inc" }));

  const result = await importProject(runId, "dok-prj-blink");

  assert.equal(result.projectName, "Blink");
  assert.ok(result.created >= 5, `created ${result.created}`);

  const apps = await db.select().from(appsTable);
  assert.deepEqual(
    apps.map((a) => a.name).sort(),
    ["blink-api", "blink-web"],
  );

  const web = apps.find((a) => a.name === "blink-web")!;
  // Nothing was deployed: the source instance is still serving those hostnames.
  assert.equal(web.status, "idle");
  assert.equal(web.source, "github");
  assert.equal(web.repoRepo, "acme/blink");
  assert.equal(web.repoBranch, "main");

  const api = apps.find((a) => a.name === "blink-api")!;
  assert.equal(api.source, "docker-image");
  assert.equal(api.dockerImage, "ghcr.io/acme/api:1.4.2");

  // Env vars, with the build arg folded in and the secret-looking one masked.
  const env = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, web.id));
  const byKey = new Map(env.map((e) => [e.key, e]));
  assert.deepEqual(
    [...byKey.keys()].sort(),
    ["DATABASE_URL", "NEXT_PUBLIC_SITE", "NODE_ENV"],
  );
  assert.equal(byKey.get("DATABASE_URL")!.type, "secret");
  assert.equal(byKey.get("NODE_ENV")!.type, "plain");

  // The database could not be created against a host with no agent, and that is
  // a REPORT row carrying the host's own words - not a failed import.
  const report = await asOwner(() => getDokployImport(runId));
  const dbRow = report!.items.find((i) => i.sourceKind === "postgres")!;
  assert.equal(dbRow.outcome, "failed");
  assert.match(dbRow.message!, /not provisioned yet/);
});

test("the primary domain is the real hostname, not Dokploy's throwaway one", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
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
  assert.equal(doms.some((d) => d.name.endsWith(".traefik.me")), false);
});

test("the compose file arrives with Dokploy's network taken out", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
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
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const shared = await db.select().from(sharedVarsTable);
  assert.deepEqual(shared.map((s) => s.key).sort(), ["ENV_LEVEL", "SHARED_TOKEN"]);
  // The LINK is what injects (ADR-0012) — a scope alone would inject nothing.
  const links = await db.select().from(sharedVarAppsTable);
  assert.ok(links.length >= 2, `expected app links, got ${links.length}`);
  assert.equal(
    shared.find((s) => s.key === "SHARED_TOKEN")!.type,
    "secret",
    "a token-looking key is not left readable",
  );
});

test("an environment Dokploy calls production reuses the one Deplo already made", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const projectId = (await db.select().from(appsTable))[0].projectId!;
  const envs = await asOwner(() => listEnvironmentsForProject(projectId));
  // Deplo seeds Development / Preview / Production; nothing was added beside them.
  assert.deepEqual(
    envs.map((e) => e.name).sort(),
    ["Development", "Preview", "Production"],
  );
});

test("running the same import again creates nothing", async () => {
  const first = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await importProject(first, "dok-prj-blink");
  const appsAfterFirst = (await db.select().from(appsTable)).length;

  const second = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  const result = await importProject(second, "dok-prj-blink");

  assert.equal((await db.select().from(appsTable)).length, appsAfterFirst);
  assert.equal(result.created, 0, JSON.stringify(result.items));
  assert.ok(result.skipped >= 4, `skipped ${result.skipped}`);
});

test("one service Dokploy will not return does not stop the others", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  __setDokployFetchForTest(routingFetch({ failApplication: "dok-app-api" }));
  const result = await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  assert.deepEqual(apps.map((a) => a.name), ["blink-web"]);
  assert.match(
    result.items.find((i) => i.sourceName === "blink-api")!.message!,
    /Dokploy request failed \(500\)/,
  );
  // The app before it, and the database after it, were both still attempted.
  assert.ok(result.created >= 3, `created ${result.created}`);
  assert.ok(result.items.some((i) => i.sourceKind === "postgres"));
});

test("an engine Deplo does not have is settled without asking Dokploy about it", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  calls = [];
  const result = await importProject(runId, "dok-prj-other");

  const row = result.items.find((i) => i.sourceKind === "libsql")!;
  assert.equal(row.outcome, "unsupported");
  assert.match(row.message!, /no libsql engine/);
  // Not a 404 dressed up as a finding: the detail call is never made.
  assert.equal(calls.includes("libsql.one"), false);
});

test("only the picked services come over, and the rest are not even read", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  calls = [];
  const result = await asOwner(() =>
    importDokployProject({
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
    result.items.some((i) => i.sourceName === "blink-web" || i.sourceKind === "postgres"),
    false,
  );
  assert.equal(calls.includes("postgres.one"), false);
});

test("each app lands on the server it was placed on, and builds where it was told", async () => {
  const SERVER_2 = "srv_2";
  await seedServer(db, SERVER_2);
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await asOwner(() =>
    importDokployProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web", "dok-app-api"],
      placements: [
        { serviceId: "dok-app-web", serverId: SERVER_1 },
        { serviceId: "dok-app-api", serverId: SERVER_2, buildServerId: SERVER_1 },
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
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  const result = await asOwner(() =>
    importDokployProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      serviceIds: ["dok-app-web"],
      placements: [{ serviceId: "dok-app-web", serverId: "srv_from_another_team" }],
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
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  const result = await asOwner(() =>
    importDokployProject({
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
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  const result = await importProject(runId, "dok-prj-blink");

  const projectItem = result.items.find((i) => i.sourceKind === "project")!;
  assert.equal(projectItem.outcome, "skipped");
  assert.match(projectItem.message!, /already here/);
});

/* ------------------------------------------------------------------ */
/* The run and its history                                             */
/* ------------------------------------------------------------------ */

test("the run keeps the report after the tab is gone", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE, orgName: "Acme Inc" }));
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishDokployImport(runId));

  const runs = await asOwner(() => listDokployImports());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].orgName, "Acme Inc");
  assert.ok(runs[0].created > 0);
  assert.ok(runs[0].manual > 0, "the things needing a person are counted");
  assert.ok(runs[0].finishedAt);

  const full = await asOwner(() => getDokployImport(runId));
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
  const { server } = await asOwner(() => addServer({ name, host, importOnly: true }));
  if (withAgent)
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: `sha256:${server.id}`, agentPort: 9443 })
      .where(eq(serversTable.id, server.id));
  return server.id;
}

test("finishing an import takes Deplo's agent back off the migration source", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.70");
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));

  await asOwner(() => finishDokployImport(runId));

  assert.equal(
    await asOwner(() => getServerById(id)),
    null,
    "the source outlived the migration - someone has to go and remove it by hand",
  );
});

test("data that did not copy KEEPS the source, agent and all", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.71");
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await appendRunItem(runId, {
    path: "Blink / production / api",
    sourceKind: "volume",
    sourceName: "api-data",
    outcome: "failed",
    message: "the copy failed",
  });

  await asOwner(() => finishDokployImport(runId));

  assert.ok(
    await asOwner(() => getServerById(id)),
    "the only way back to the bytes was uninstalled",
  );
  const full = await asOwner(() => getDokployImport(runId));
  assert.match(
    full!.items.find((i) => i.sourceKind === "server")!.message!,
    /still on dokploy-host: data that did not copy/,
  );
});

test("a host that will not let go keeps its row, and the report says so", async () => {
  const id = await seedSource("dokploy-host", "192.0.2.72", true);
  // An agent too old to know the RPC: it never advertises the capability, so
  // every retry lands on the same refusal.
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({ capabilities: ["self-update"] }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));

  await asOwner(() => finishDokployImport(runId));

  assert.ok(await asOwner(() => getServerById(id)), "the row must survive");
  const full = await asOwner(() => getDokployImport(runId));
  assert.match(
    full!.items.find((i) => i.sourceKind === "server")!.message!,
    /could not remove its own agent from dokploy-host after 3 tries/,
  );
});

test("a run left open by a closed tab is closed as interrupted by the next one", async () => {
  const abandoned = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await asOwner(() => beginDokployImport({ url: URL_BASE }));

  const runs = await asOwner(() => listDokployImports());
  const old = runs.find((r) => r.id === abandoned)!;
  assert.equal(old.status, "failed");
  assert.equal(old.error, "Interrupted");
  assert.equal(runs.filter((r) => r.status === "running").length, 1);
});

test("an import run belongs to its team", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
        importDokployProject({ ...CONNECT, runId, projectId: "dok-prj-blink" }),
      ),
    /scoped to a team the user no longer belongs to|does not belong to this team/,
  );
});

/* ------------------------------------------------------------------ */
/* The fake's request router                                           */
/* ------------------------------------------------------------------ */

/**
 * A fetch that answers `application.one` by the id in the query string, so one
 * fake can serve a project with several applications — and can be told to fail
 * exactly one of them.
 */
function routingFetch(opts: { failApplication?: string } = {}) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const procedure = url.pathname.replace(/^\/api\//, "");
    calls.push(procedure);
    assert.equal((init?.headers as Record<string, string>)["x-api-key"], CONNECT.apiKey);

    if (procedure === "application.one") {
      const id = url.searchParams.get("applicationId") ?? "";
      if (id === opts.failApplication)
        return new Response("upstream exploded", { status: 500 });
      const body = APPLICATIONS[id];
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
 * The port a database publishes over there is the port it should publish here,
 * and for a long time it simply did not arrive.
 *
 * `mapDatabase` read Dokploy's `externalPort` all along - what dropped it was the
 * create: publishing 5432 fails while the Dokploy container still holds it (which
 * is the NORMAL state of a migration, since the source is stopped later, to read
 * its volume), and the fallback quietly made an unexposed database and wrote a
 * line in the report. These cover the three ways it can now end instead: the
 * review picked another port, the review said not to publish, and the only thing
 * holding the port was the source itself.
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
  (await asOwner(() => getDokployImport(runId)))!
    .items.filter((i) => i.sourceKind === "postgres")
    .map((i) => i.message ?? "")
    .join(" | ");

test("a database keeps the host port it published on Dokploy", async () => {
  await provisionServer1();
  await grantExposePorts();
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
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

test("the review can move that port, or refuse to publish it at all", async () => {
  await provisionServer1();
  await grantExposePorts();

  const runA = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await asOwner(() =>
    importDokployProject({
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
  const runB = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await asOwner(() =>
    importDokployProject({
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

  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
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
  // The plan still SAYS what the source publishes - that is a fact about the
  // other platform, and the review needs it to count how many databases are
  // about to lose theirs - but the import says the true reason rather than
  // blaming the old instance.
  const plan = await asOwner(() => scanDokploy(CONNECT));
  const planned = plan.projects
    .flatMap((p) => p.environments.flatMap((e) => e.services))
    .find((s) => s.sourceId === "dok-pg-1")!;
  assert.equal(planned.exposedPort, 5432);

  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
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
 *
 * The property that matters is not "it deletes things" - it is the LINE it
 * draws. A run that reused something already here recorded that as `skipped`,
 * and a revert that walked outcomes carelessly would delete a project somebody
 * had been using for a year because a Dokploy project happened to share its
 * name. So both directions are asserted, in the same fixture.
 */

test("a revert removes what the run created", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);
  assert.ok((await db.select().from(appsTable)).length > 0, "nothing was imported");

  const result = await asOwner(() => revertDokployImport(runId));
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

test("a revert never touches a project the run only reused", async () => {
  // Same name Dokploy uses, created here first: `ensureProject` reuses it and
  // records `skipped`, so it is not the run's to take away.
  const mine = await asOwner(() => createProject("Blink"));
  await seedApp(db, { id: "prj_keep", projectId: mine.id });

  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  const result = await asOwner(() => revertDokployImport(runId));
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
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  await assert.rejects(
    () => runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () => revertDokployImport(runId)),
    /no longer belongs|not found|permission/i,
  );
  // And nothing moved.
  assert.ok((await db.select().from(appsTable)).length > 0);
});

test("stopping a run closes it WITHOUT taking the agents off the source", async () => {
  // The machine the migration reads from, registered the way the install step
  // registers it.
  const SOURCE = "srv_stop_source";
  await seedServer(db, SOURCE);
  await db
    .update(serversTable)
    .set({ importOnly: true })
    .where(eq(serversTable.id, SOURCE));

  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  await asOwner(() => stopDokployImport(runId));

  const rows = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  assert.equal(rows[0].status, "stopped");
  // Still ours, still reachable - re-running is how a stopped migration is
  // resumed, and it cannot be if the agent has been uninstalled.
  assert.ok(await asOwner(() => getServerById(SOURCE)), "the source was removed");

  // Idempotent, and it never overwrites a verdict a run reached on its own.
  await asOwner(() => stopDokployImport(runId));
  const again = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  assert.equal(again[0].status, "stopped");
});
