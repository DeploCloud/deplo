import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import * as yaml from "js-yaml";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { envVars as envVarsTable } from "../db/schema/control-plane/env-vars";
import { migrationRunItems as itemsTable } from "../db/schema/control-plane/migration";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "./identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains/dns-check";
import { settleProvisioning } from "./backup-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { __resetAcceptedKeysForTest } from "../migration/dokploy/client";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../migration/transport";
import { __resetCoolifyIndexForTest } from "../migration/coolify/adapter";
import { __resetCoolifyRateLimitForTest } from "../migration/coolify/client";
import { decryptSecret } from "../crypto";
import { importMigrationProject } from "./migration-import/project-import";
import { beginMigration } from "./migration-import/run-lifecycle";
import { scanMigrationSource } from "./migration-import/scan";

let db: TestDb;
let pg: PGlite;
let fixtures: Record<string, unknown>;
let calls: string[];

const URL_BASE = "https://coolify.acme.test";
const CONNECT = {
  url: URL_BASE,
  apiKey: "3|abcdefghijklmnopqrstuvwxyz012345",
  kind: "coolify" as const,
};

const COMPOSE_WITH_COOLIFY_NETWORK = [
  "services:",
  "  app:",
  "    image: ghcr.io/acme/wp:6",
  "    networks:",
  "      - default",
  "networks:",
  "  default:",
  "    name: app-stack",
  "    external: true",
].join("\n");

function defaultFixtures(): Record<string, unknown> {
  return {
    team: { id: 1, name: "Acme Inc" },
    "team/members": [
      { id: 1, name: "Ada", email: "ada@acme.com" },
      { id: 2, name: "Grace", email: "grace@acme.com" },
    ],
    servers: [
      {
        id: 0,
        uuid: "srv-local",
        name: "localhost",
        ip: "host.docker.internal",
      },
      { id: 3, uuid: "srv-eu", name: "eu-1", ip: "10.9.9.9" },
    ],
    "servers/srv-local/resources": [
      { uuid: "app-web", name: "web", type: "application" },
      { uuid: "svc-wp", name: "wordpress", type: "service" },
      { uuid: "db-main", name: "main", type: "postgresql" },
      { uuid: "db-cache", name: "cache", type: "keydb" },
      { uuid: "app-stack", name: "stack", type: "application" },
    ],
    "servers/srv-eu/resources": [],
    projects: [{ uuid: "prj-blink", name: "Blink" }],
    "projects/prj-blink/environments": [
      { id: 2, uuid: "env-prod", name: "production", project_id: 1 },
    ],
    applications: [
      {
        uuid: "app-web",
        name: "web",
        environment_id: 2,
        build_pack: "nixpacks",
        git_repository: "https://github.com/acme/web",
        git_branch: "main",
        ports_exposes: "3000",
        fqdn: "https://web.acme.com",
        status: "running:healthy",
        limits_memory: "512M",
        is_http_basic_auth_enabled: true,
        http_basic_auth_username: "ops",
        http_basic_auth_password: "letmein",
        custom_docker_run_options: "--gpus all",
        health_check_enabled: true,
        health_check_path: "/healthz",
        health_check_port: "3000",
        health_check_interval: 20,
        health_check_timeout: 4,
        health_check_retries: 5,
        health_check_start_period: 15,
        health_check_method: "POST",
      },
      {
        uuid: "app-stack",
        name: "stack",
        environment_id: 2,
        build_pack: "dockercompose",
        docker_compose_raw: COMPOSE_WITH_COOLIFY_NETWORK,
        status: "running",
      },
    ],
    services: [
      {
        uuid: "svc-wp",
        name: "wordpress",
        environment_id: 2,
        docker_compose_raw:
          "services:\n  wp:\n    image: wordpress:6\n    ports:\n      - '80'\n",
        status: "running",
      },
    ],
    databases: [
      {
        uuid: "db-main",
        name: "main",
        environment_id: 2,
        type: "standalone-postgresql",
        image: "postgres:16",
        postgres_user: "app",
        postgres_password: "s3cret",
        postgres_db: "appdb",
        status: "running",
      },
      {
        uuid: "db-cache",
        name: "cache",
        environment_id: 2,
        type: "standalone-keydb",
        image: "eqalpha/keydb:latest",
        keydb_password: "kp",
        status: "running",
      },
    ],
    "applications/app-web": null,
    "applications/app-web/envs": [
      { key: "NODE_ENV", value: "production" },
      { key: "SECRET", value: "$SERVICE_PASSWORD_APP", real_value: "aB3k9" },
      { key: "ONLY_PREVIEW", value: "x", is_preview: true },
      { key: "TEAM_WIDE", value: "{{team.TEAM_WIDE}}", real_value: "t" },
      { key: "MAIL", value: "{{project.PROJECT_WIDE}}", real_value: "p" },
    ],
    "applications/app-web/storages": {
      persistent_storages: [
        { uuid: "s1", name: "web-data-app-web", mount_path: "/app/storage" },
      ],
      file_storages: [],
    },
    "applications/app-web/scheduled-tasks": [
      {
        uuid: "t1",
        name: "prune",
        command: "php artisan prune",
        frequency: "daily",
      },
    ],
    "applications/app-stack/envs": [{ key: "WP_ENV", value: "prod" }],
    "applications/app-stack/storages": {},
    "applications/app-stack/scheduled-tasks": [],
    "services/svc-wp/envs": [{ key: "WORDPRESS_DB_HOST", value: "db" }],
    "services/svc-wp/storages": {},
    "services/svc-wp/scheduled-tasks": [],
    "databases/db-main/envs": [],
    "databases/db-main/storages": {},
    "databases/db-cache/envs": [],
    "databases/db-cache/storages": {},
    "projects/prj-blink/envs": [{ key: "PROJECT_WIDE", value: "p" }],
    "projects/prj-blink/environments/production/envs": [
      { key: "ENV_WIDE", value: "e" },
    ],
    "team/envs": [{ key: "TEAM_WIDE", value: "t" }],
    "servers/srv-local/envs": [{ key: "SERVER_WIDE", value: "s" }],
    "servers/srv-eu/envs": [],
    "s3-storages": [
      {
        uuid: "s3-1",
        name: "nightly",
        endpoint: "https://s3.acme.test",
        bucket: "backups",
        region: "eu-west-1",
        key: "AK",
        secret: "SK",
      },
    ],
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function routingFetch() {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (!url.pathname.startsWith("/api/v1/"))
      return new Response("not found", { status: 404 });
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${CONNECT.apiKey}`,
    );

    const single = /^(applications|services|databases)\/([^/]+)$/.exec(path);
    if (single) {
      const list = fixtures[single[1]] as { uuid: string }[] | undefined;
      const row = list?.find((r) => r.uuid === single[2]);
      return row ? json(row) : new Response("not found", { status: 404 });
    }
    if (/\/stop$/.test(path)) return json({ message: "stopped" });

    const hit = fixtures[path];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (hit && typeof hit === "object" && "__status" in hit) {
      const fail = hit as { __status: number; body?: string };
      return new Response(fail.body ?? "boom", { status: fail.__status });
    }
    return json(hit);
  };
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setDnsResolve4ForTest(async () => ["10.0.0.1"]);
});

after(async () => {
  await settleProvisioning(db);
  __resetDnsResolve4ForTest();
  __resetMigrationFetchForTest();
  __resetCoolifyRateLimitForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await settleProvisioning(db);
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await db.execute("truncate table migration_runs cascade;");
  await db.execute("truncate table databases cascade;");
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  fixtures = defaultFixtures();
  __setMigrationFetchForTest(routingFetch());
  __resetAcceptedKeysForTest();
  __setAgentConnectorForTest();
  __resetCoolifyRateLimitForTest();
  calls = [];
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("the scan reads the whole tree and says it is a Coolify", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.equal(plan.platform, "coolify");
  assert.equal(plan.orgName, "Acme Inc");
  assert.deepEqual(
    plan.projects.map((p) => p.name),
    ["Blink"],
  );
  const env = plan.projects[0].environments[0];
  assert.equal(env.name, "production");
  assert.deepEqual(
    env.services.map((s) => [s.kind, s.name]).sort(),
    [
      ["application", "web"],
      ["compose", "stack"],
      ["compose", "wordpress"],
      ["keydb", "cache"],
      ["postgres", "main"],
    ].sort(),
  );
});

test("an engine Deplo does not have is refused by name, not forgotten", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const cache = plan.projects[0].environments[0].services.find(
    (s) => s.name === "cache",
  );
  assert.equal(cache?.status, "unsupported");
  assert.match(cache?.notes.join(" ") ?? "", /keydb/);
});

test("the panel's own host is the machine the wizard offers first", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.deepEqual(
    plan.servers.map((s) => s.sourceId),
    [""],
  );
  fixtures["servers/srv-eu/resources"] = (
    fixtures["servers/srv-local/resources"] as unknown[]
  ).splice(0, 1);
  __resetCoolifyIndexForTest();
  const both = await asOwner(() => scanMigrationSource(CONNECT));
  assert.deepEqual(
    both.servers.map((s) => s.sourceId),
    ["", "srv-eu"],
  );
});

test("a scan writes nothing on either side", async () => {
  await asOwner(() => scanMigrationSource(CONNECT));
  assert.equal(
    calls.some((c) => c.startsWith("POST")),
    false,
  );
  const rows = await db.select().from(appsTable);
  assert.equal(rows.length, 0);
});

test("a token that cannot read values is refused before anything happens", async () => {
  fixtures.databases = [
    {
      uuid: "db-main",
      name: "main",
      environment_id: 2,
      type: "standalone-postgresql",
      image: "postgres:16",
    },
  ];
  await assert.rejects(
    () => asOwner(() => scanMigrationSource(CONNECT)),
    /cannot read values/,
  );
});

test("with no database, the refusal comes from a resource's own variables", async () => {
  fixtures.databases = [];
  fixtures["applications/app-web/envs"] = [{ key: "NODE_ENV" }];
  await assert.rejects(
    () => asOwner(() => scanMigrationSource(CONNECT)),
    /cannot read values/,
  );
});

async function importAll(): Promise<string> {
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, orgName: "Acme Inc", kind: "coolify" }),
  );
  await asOwner(() =>
    importMigrationProject({ ...CONNECT, runId, projectId: "prj-blink" }),
  );
  return runId;
}

test("a project lands: apps, a stack, a database and its variables", async () => {
  await importAll();

  const apps = await db.select().from(appsTable);
  assert.deepEqual(apps.map((a) => a.name).sort(), [
    "stack",
    "web",
    "wordpress",
  ]);

  const items = await db.select().from(itemsTable);
  const pg = items.find((i) => i.sourceKind === "postgres")!;
  assert.equal(pg.outcome, "failed");
  assert.match(pg.message ?? "", /not provisioned yet/);
  assert.equal((await db.select().from(databasesTable)).length, 0);

  const web = apps.find((a) => a.name === "web")!;
  const vars = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, web.id));
  const keys = vars.map((v) => v.key).sort();
  assert.deepEqual(keys, ["MAIL", "NODE_ENV", "SECRET"]);
  assert.equal(keys.includes("ONLY_PREVIEW"), false);
});

test("a compose-built application lands as a stack, not as an app", async () => {
  await importAll();
  const stack = (await db.select().from(appsTable)).find(
    (a) => a.name === "stack",
  )!;
  assert.equal(stack.source, "compose");
  const doc = yaml.load(stack.compose ?? "") as {
    networks?: Record<string, unknown>;
  };
  assert.equal(doc.networks, undefined);
});

test("the domain comes across with its scheme and host", async () => {
  await importAll();
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "web",
  )!;
  const domains = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  assert.deepEqual(
    domains.map((d) => d.name),
    ["web.acme.com"],
  );
});

test("what has no home here becomes a line in the report", async () => {
  const runId = await importAll();
  const items = await db
    .select()
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));
  const messages = items.map((i) => i.message ?? "").join("\n");
  assert.match(messages, /--gpus all/);
  assert.doesNotMatch(messages, /\{panel\}/);
  assert.doesNotMatch(messages, /Dokploy/);
  assert.match(messages, /Coolify/);
});

test("a run started as Coolify records the platform it read", async () => {
  const runId = await importAll();
  const [row] = (
    await db.execute(
      `select platform from migration_runs where id = '${runId}'`,
    )
  ).rows as { platform: string }[];
  assert.equal(row.platform, "coolify");
});

test("nothing is deployed and the source is still running", async () => {
  await importAll();
  const apps = await db.select().from(appsTable);
  assert.equal(
    apps.every((a) => a.status !== "active"),
    true,
  );
  assert.equal(
    calls.some((c) => c.includes("/stop")),
    false,
  );
});

test("the health check comes across, and what does not fit is a note", async () => {
  await importAll();
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "web",
  )!;
  assert.equal(web.healthCheckEnabled, true);
  assert.equal(web.healthCheckPath, "/healthz");
  assert.equal(web.healthCheckPort, 3000);
  assert.equal(web.healthCheckIntervalS, 20);
  assert.equal(web.healthCheckRetries, 5);

  const items = await db.select().from(itemsTable);
  assert.match(
    items.map((i) => i.message ?? "").join("\n"),
    /also checked method POST/,
  );
});

test("shared variables come across at every level, including the server one", async () => {
  await importAll();
  const shared = await db.execute(
    `select v.key, (t.team_id is not null) as team_wide
       from shared_env_vars v
       left join shared_env_var_teams t on t.var_id = v.id
      order by v.key`,
  );
  assert.deepEqual(
    (shared.rows as { key: string; team_wide: boolean }[]).map((r) => [
      r.key,
      r.team_wide,
    ]),
    [
      ["ENV_WIDE", false],
      ["PROJECT_WIDE", false],
      ["SERVER_WIDE", false],
      ["TEAM_WIDE", true],
    ],
  );
});

test("only the app that REFERENCED a shared variable is linked to it", async () => {
  await importAll();
  const links = await db.execute(
    `select v.key, a.slug from shared_env_var_apps l
       join shared_env_vars v on v.id = l.var_id
       join apps a on a.id = l.app_id
      order by v.key, a.slug`,
  );
  assert.deepEqual(
    (links.rows as { key: string; slug: string }[]).map((r) => r.key),
    ["TEAM_WIDE"],
  );
  const rows = await db.execute(
    `select e.key, e.value_enc from env_vars e
       join apps a on a.id = e.app_id
      where a.name = 'web' order by e.key`,
  );
  const keys = (rows.rows as { key: string }[]).map((r) => r.key);
  assert.equal(keys.includes("TEAM_WIDE"), false);
  assert.equal(keys.includes("MAIL"), true);
  const mail = (rows.rows as { key: string; value_enc: string }[]).find(
    (r) => r.key === "MAIL",
  );
  assert.equal(decryptSecret(mail!.value_enc), "p");
  const items = await db.select().from(itemsTable);
  const messages = items.map((i) => i.message ?? "").join("\n");
  assert.match(messages, /linked to the shared variable of the same name/);
  assert.match(messages, /cannot be called something else/);
});

test("a backup destination comes across and is tried at once", async () => {
  const runId = await importAll();
  const dests = await db.execute("select name, bucket from backup_destination");
  assert.deepEqual(
    (dests.rows as { name: string; bucket: string }[]).map((d) => [
      d.name,
      d.bucket,
    ]),
    [["nightly", "backups"]],
  );
  const item = (await db.select().from(itemsTable))
    .filter((i) => i.runId === runId)
    .find((i) => i.sourceKind === "destination")!;
  assert.equal(item.outcome, "manual");
  assert.match(item.message ?? "", /did not answer/);
});
