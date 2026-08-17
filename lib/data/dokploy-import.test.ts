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
  domains as domainsTable,
  envVars as envVarsTable,
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
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { __setDnsResolve4ForTest, __resetDnsResolve4ForTest } from "./domains";
import {
  __setDokployFetchForTest,
  __resetDokployFetchForTest,
} from "../dokploy/client";
import {
  beginDokployImport,
  finishDokployImport,
  getDokployImport,
  importDokployProject,
  listDokployImports,
  scanDokploy,
} from "./dokploy-import";
import { createProject } from "./projects";
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
            postgres: [{ postgresId: "dok-pg-1", name: "blink-db", serverId: null }],
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
  __resetDnsResolve4ForTest();
  __resetDokployFetchForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await db.execute("truncate table dokploy_imports cascade;");
  await seedIdentity(db);
  await seedServer(db);
  fixtures = defaultFixtures();
  __setDokployFetchForTest(routingFetch());
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
  assert.deepEqual(
    plan.servers.map((s) => s.name),
    ["eu-1"],
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
  assert.match(stack.notes.join(" "), /shared network will be removed/);

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

test("databases can be left out entirely", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: URL_BASE }));
  const result = await asOwner(() =>
    importDokployProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      skipDatabases: true,
    }),
  );
  assert.equal((await db.select().from(databasesTable)).length, 0);
  assert.match(
    result.items.find((i) => i.sourceKind === "postgres")!.message!,
    /left out of this import/,
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
