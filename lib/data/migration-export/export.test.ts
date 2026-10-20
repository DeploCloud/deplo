import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { membershipCapabilities } from "../../db/schema/control-plane/access-control";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { folders as foldersTable } from "../../db/schema/control-plane/projects";
import { ALL_CAPABILITIES } from "../../types/identity";
import { appBasicAuthUsers } from "../../db/schema/control-plane/domains";
import { runWithIdentity } from "../../auth/request-context";
import { encryptSecret } from "../../crypto";
import { insertDomain, insertEnvVars } from "../app-graph-load";
import { seedApp, seedServer } from "../app-graph-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedDestination,
  seedRun,
  TRUNCATE_BACKUPS,
} from "../backup-test-helpers";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { DEPLO_EXPORT_VERSION } from "../../migration/deplo/export-shape";
import { instanceFingerprint } from "../../migration/deplo/instance";
import { __resetExportTrailForTest, exportTeamForMigration } from "./export";
import {
  ExportRefusedError,
  openAppUpload,
  openWorkloadData,
} from "./data-stream";
import { storeUpload } from "../../deploy/upload";
import type { Domain } from "../../types/domain";
import { withTraefikCertificates } from "../../deploy/traefik-stack";
import {
  __setAgentConnectorForTest,
  type AgentConnection,
} from "../../infra/agent-client/connect";
import {
  ACME_CERT,
  ACME_KEY,
  TRAEFIK_STACK,
} from "../certificate-test-fixtures";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USER_NO_REVEAL = "user_no_reveal";
const USER_B = "user_b";
const INTRUDER = "user_intruder";
const T0 = "2026-01-01T00:00:00.000Z";

let db: TestDb;
let pg: PGlite;

let dataDir = "";
const priorDataDir = process.env.DEPLO_DATA_DIR;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  dataDir = mkdtempSync(join(tmpdir(), "deplo-export-"));
  process.env.DEPLO_DATA_DIR = dataDir;
});

after(async () => {
  __resetTestDb();
  await pg.close();
  if (priorDataDir === undefined) delete process.env.DEPLO_DATA_DIR;
  else process.env.DEPLO_DATA_DIR = priorDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function uploadArchive(appId: string, bytes: string) {
  const stored = await storeUpload({
    appId,
    filename: "site.tar.gz",
    ext: ".tar.gz",
    body: new Blob([bytes]).stream(),
  });
  await db
    .update(appsTable)
    .set({
      source: "upload",
      uploadId: stored.id,
      uploadFilename: stored.filename,
      uploadPath: stored.path,
      uploadSize: stored.size,
      uploadUploadedAt: stored.uploadedAt,
    })
    .where(eq(appsTable.id, appId));
  return stored;
}

async function drain(chunks: AsyncIterable<Buffer>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of chunks) parts.push(c);
  return Buffer.concat(parts).toString();
}

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId }, fn);

beforeEach(async () => {
  __resetExportTrailForTest();
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table activities, app_build_method_settings, app_build, apps,
      servers, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: USER_NO_REVEAL,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_env", "configure_apps"],
      },
      { id: USER_B, teamId: TEAM_B, role: "owner" },
      { id: INTRUDER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  await seedApp(db, {
    id: "prj_web",
    teamId: TEAM_A,
    compose: "services:\n  web:\n    image: nginx\n",
    source: "compose",
    repo: null,
  });
  await seedApp(db, { id: "prj_other", teamId: TEAM_B });
  await insertEnvVars(db as unknown as Parameters<typeof insertEnvVars>[0], [
    {
      id: "env_plain",
      appId: "prj_web",
      key: "PUBLIC_URL",
      valueEnc: encryptSecret("https://example.com"),
      targets: ["production", "preview"],
      type: "plain",
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "env_secret",
      appId: "prj_web",
      key: "API_KEY",
      valueEnc: encryptSecret("s3cr3t"),
      targets: ["production"],
      type: "secret",
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await db.insert(appBasicAuthUsers).values({
    id: "bau_1",
    appId: "prj_web",
    username: "alice",
    passwordEnc: encryptSecret("hunter22"),
    createdAt: T0,
    updatedAt: T0,
  });
  await seedDatabase(db, { id: "db_main", name: "main" });
});

test("the export carries the team's apps and databases with their secret values", async () => {
  const out = await as(USER_1, TEAM_A, () => exportTeamForMigration());
  assert.equal(out.version, DEPLO_EXPORT_VERSION);
  assert.equal(out.team.id, TEAM_A);
  assert.equal(out.instance, instanceFingerprint());

  const web = out.apps.find((a) => a.id === "prj_web");
  assert.ok(web);
  assert.deepEqual(web.env.map((e) => [e.key, e.value, e.secret]).sort(), [
    ["API_KEY", "s3cr3t", true],
    ["PUBLIC_URL", "https://example.com", false],
  ]);
  assert.deepEqual(web.basicAuth, [
    { username: "alice", password: "hunter22" },
  ]);
  assert.match(web.compose ?? "", /image: nginx/);
  assert.ok(
    web.data.volumes.every((v) => v.name.startsWith("deplo-prj_web")),
    "volume names are the ones on the host",
  );

  const main = out.databases.find((d) => d.id === "db_main");
  assert.equal(main?.password, "pw");
  assert.equal(main?.data.volumes[0]?.name, "deplo-db-main_db-main-data");
});

test("another team's apps never leave in this team's export", async () => {
  const out = await as(USER_1, TEAM_A, () => exportTeamForMigration());
  assert.equal(
    out.apps.some((a) => a.id === "prj_other"),
    false,
  );
});

test("a member who cannot reveal secrets cannot export", async () => {
  await assert.rejects(() =>
    as(USER_NO_REVEAL, TEAM_A, () => exportTeamForMigration()),
  );
});

test("reading the export is written to Activity once per sitting", async () => {
  await as(USER_1, TEAM_A, () => exportTeamForMigration());
  await as(USER_1, TEAM_A, () => exportTeamForMigration());
  const rows = await db
    .select({ message: activities.message })
    .from(activities)
    .where(eq(activities.teamId, TEAM_A));
  assert.equal(rows.filter((r) => /another Deplo/.test(r.message)).length, 1);
});

test("the data stream refuses a volume the named workload does not mount", async () => {
  await assert.rejects(
    () =>
      as(USER_1, TEAM_A, () =>
        openWorkloadData(
          { kind: "database", id: "db_main" },
          { volume: "deplo-postgres" },
        ),
      ),
    (e: unknown) => e instanceof ExportRefusedError && e.status === 404,
  );
});

test("the data stream does not answer for another team's workload", async () => {
  await assert.rejects(
    () =>
      as(USER_1, TEAM_A, () =>
        openWorkloadData(
          { kind: "app", id: "prj_other" },
          { volume: "deplo-prj_other-data" },
        ),
      ),
    (e: unknown) => e instanceof ExportRefusedError && e.status === 404,
  );
});

test("the data stream asks the owning server for a volume the workload does mount", async () => {
  await assert.rejects(
    () =>
      as(USER_1, TEAM_A, () =>
        openWorkloadData(
          { kind: "database", id: "db_main" },
          { volume: "deplo-db-main_db-main-data" },
        ),
      ),
    (e: unknown) => !(e instanceof ExportRefusedError),
  );
});

test("an app in a private folder the reader cannot open is counted, never handed over", async () => {
  await db
    .delete(membershipCapabilities)
    .where(eq(membershipCapabilities.membershipId, `mem_${INTRUDER}`));
  await db.insert(membershipCapabilities).values(
    ALL_CAPABILITIES.filter((c) => c !== "manage_team").map((capability) => ({
      membershipId: `mem_${INTRUDER}`,
      capability,
    })),
  );
  await db.insert(foldersTable).values({
    id: "fld_private",
    teamId: TEAM_A,
    name: "Private",
    ownerUserId: USER_1,
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .update(appsTable)
    .set({ folderId: "fld_private" })
    .where(eq(appsTable.id, "prj_web"));

  const out = await as(INTRUDER, TEAM_A, () => exportTeamForMigration());
  assert.equal(
    out.apps.some((a) => a.id === "prj_web"),
    false,
  );
  assert.equal(out.withheld, 1);
  await assert.rejects(
    () =>
      as(INTRUDER, TEAM_A, () =>
        openWorkloadData(
          { kind: "app", id: "prj_web" },
          { volume: "deplo-prj_web-data" },
        ),
      ),
    (e: unknown) => e instanceof ExportRefusedError && e.status === 404,
  );

  const owner = await as(USER_1, TEAM_A, () => exportTeamForMigration());
  assert.equal(owner.withheld, 0);
  assert.ok(owner.apps.some((a) => a.id === "prj_web"));
});

test("every backup destination, schedule and restore point leaves in the export", async () => {
  await seedDestination(db, { id: "dst_s3", name: "bucket" });
  await seedDestination(db, {
    id: "dst_disk",
    name: "disk",
    kind: "server",
    path: "/mnt/backups",
  });
  await seedBackup(db, {
    id: "bkp_off",
    destinationId: "dst_disk",
    databaseId: "db_main",
    schedule: "0 2 * * *",
    timezone: "Europe/Paris",
    enabled: false,
  });
  await seedRun(db, {
    id: "brun_ok",
    destinationId: "dst_s3",
    databaseId: "db_main",
    objectKey: "deplo/a/db_main/1.sql.gz.age",
    sizeBytes: 2048,
    sha256: "abc",
    startedAt: "2026-02-01T03:00:00.000Z",
  });
  await seedRun(db, {
    id: "brun_bad",
    destinationId: "dst_s3",
    databaseId: "db_main",
    status: "failed",
  });

  const out = await as(USER_1, TEAM_A, () => exportTeamForMigration());
  const s3 = out.destinations.find((d) => d.name === "bucket");
  assert.match(s3?.ageIdentity ?? "", /^AGE-SECRET-KEY-/);
  assert.equal(s3?.provider, "aws");
  assert.deepEqual(
    out.serverDestinations?.map((d) => ({
      ...d,
      ageIdentity: !!d.ageIdentity,
    })),
    [
      {
        name: "disk",
        serverId: "srv_1",
        serverName: out.servers.find((s) => s.id === "srv_1")?.name ?? null,
        path: "/mnt/backups",
        ageIdentity: true,
      },
    ],
  );
  const main = out.databases.find((d) => d.id === "db_main")!;
  assert.deepEqual(main.backups, [
    {
      schedule: "0 2 * * *",
      enabled: false,
      timezone: "Europe/Paris",
      retentionCount: 7,
      destination: "disk",
    },
  ]);
  assert.deepEqual(main.backupRuns, [
    {
      destination: "bucket",
      objectKey: "deplo/a/db_main/1.sql.gz.age",
      sizeBytes: 2048,
      decryptedSizeBytes: null,
      sha256: "abc",
      startedAt: "2026-02-01T03:00:00.000Z",
      finishedAt: T0,
    },
  ]);
});

test("an app built from an uploaded archive names that archive in the export", async () => {
  const stored = await uploadArchive("prj_web", "the site");
  const out = await as(USER_1, TEAM_A, () => exportTeamForMigration());
  const web = out.apps.find((a) => a.id === "prj_web");
  assert.deepEqual(web?.upload, {
    filename: "site.tar.gz",
    size: 8,
    uploadedAt: stored.uploadedAt,
  });
});

test("an app with no archive says so rather than leaving the field out", async () => {
  const out = await as(USER_1, TEAM_A, () => exportTeamForMigration());
  assert.equal(out.apps.find((a) => a.id === "prj_web")?.upload, null);
});

test("the data stream hands over an app's uploaded archive byte for byte", async () => {
  await uploadArchive("prj_web", "the site");
  const { chunks, close } = await as(USER_1, TEAM_A, () =>
    openAppUpload({ kind: "app", id: "prj_web" }),
  );
  try {
    assert.equal(await drain(chunks), "the site");
  } finally {
    close();
  }
});

test("the data stream does not hand over another team's archive", async () => {
  await uploadArchive("prj_other", "not yours");
  await assert.rejects(
    () =>
      as(USER_1, TEAM_A, () => openAppUpload({ kind: "app", id: "prj_other" })),
    (e: unknown) => e instanceof ExportRefusedError && e.status === 404,
  );
});

test("the data stream answers 404 for an app with no archive", async () => {
  await assert.rejects(
    () =>
      as(USER_1, TEAM_A, () => openAppUpload({ kind: "app", id: "prj_web" })),
    (e: unknown) => e instanceof ExportRefusedError && e.status === 404,
  );
});

const seedDomain = (d: Partial<Domain> & { id: string; name: string }) =>
  insertDomain(db as unknown as Parameters<typeof insertDomain>[0], {
    appId: "prj_web",
    status: "valid",
    primary: false,
    redirectTo: null,
    ssl: true,
    source: "custom",
    createdAt: T0,
    ...d,
  });

test("a domain's routing rules leave in the export", async () => {
  await seedDomain({
    id: "dom_shop",
    name: "shop.example.com",
    primary: true,
    entrypoint: "websecure",
    certProvider: "letsencrypt",
    middlewares: ["ratelimit@file", "auth"],
    securityHeaders: false,
    corsOrigins: ["https://a.example.com", "https://b.example.com"],
    proxied: true,
  });
  await seedDomain({
    id: "dom_www",
    name: "www.shop.example.com",
    redirectTo: "shop.example.com",
    source: "redirect",
  });
  const out = await as(USER_1, TEAM_A, () => exportTeamForMigration());
  const domains = out.apps.find((a) => a.id === "prj_web")?.domains ?? [];
  const shop = domains.find((d) => d.host === "shop.example.com");
  assert.deepEqual(
    {
      entrypoint: shop?.entrypoint,
      middlewares: shop?.middlewares,
      corsOrigins: shop?.corsOrigins,
      securityHeaders: shop?.securityHeaders,
      proxied: shop?.proxied,
    },
    {
      entrypoint: "websecure",
      middlewares: ["ratelimit@file", "auth"],
      corsOrigins: ["https://a.example.com", "https://b.example.com"],
      securityHeaders: false,
      proxied: true,
    },
  );
  const www = domains.find((d) => d.host === "www.shop.example.com");
  assert.equal(www?.redirectTo, "shop.example.com");
  assert.equal(www?.securityHeaders, true);
  assert.deepEqual(www?.middlewares, []);
});

function proxyHolding(certificates: { certPem: string; keyPem: string }[]) {
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({ capabilities: ["hostops"] }),
        hostInfo: async () => ({
          traefikComposeYaml: withTraefikCertificates(
            TRAEFIK_STACK,
            certificates,
          ),
        }),
        close: () => {},
      }) as unknown as AgentConnection,
  );
}

const certificateOf = async (userId: string, host: string) =>
  (await as(userId, TEAM_A, () => exportTeamForMigration())).apps
    .find((a) => a.id === "prj_web")
    ?.domains.find((d) => d.host === host)?.certificate;

test("a custom certificate leaves with its key only for an instance admin", async (t) => {
  t.after(() => __setAgentConnectorForTest());
  await db
    .insert(membershipCapabilities)
    .values(
      ALL_CAPABILITIES.filter((c) => c !== "manage_team").map((capability) => ({
        membershipId: `mem_${INTRUDER}`,
        capability,
      })),
    )
    .onConflictDoNothing();
  await seedDomain({
    id: "dom_acme",
    name: "acme.example.com",
    certProvider: "custom",
  });
  await seedDomain({
    id: "dom_le",
    name: "le.example.com",
    certProvider: "letsencrypt",
  });
  proxyHolding([{ certPem: ACME_CERT, keyPem: ACME_KEY }]);

  assert.deepEqual(await certificateOf(USER_1, "acme.example.com"), {
    certPem: ACME_CERT,
    keyPem: ACME_KEY,
  });
  assert.equal(await certificateOf(USER_1, "le.example.com"), undefined);
  assert.deepEqual(await certificateOf(INTRUDER, "acme.example.com"), {
    withheld: "admin",
  });
});

test("a custom certificate the proxy does not hold, or cannot be read, says why", async (t) => {
  t.after(() => __setAgentConnectorForTest());
  await seedDomain({
    id: "dom_other",
    name: "other.example.com",
    certProvider: "custom",
  });
  proxyHolding([{ certPem: ACME_CERT, keyPem: ACME_KEY }]);
  assert.deepEqual(await certificateOf(USER_1, "other.example.com"), {
    withheld: "missing",
  });
  __setAgentConnectorForTest(async () => {
    throw new Error("unreachable");
  });
  assert.deepEqual(await certificateOf(USER_1, "other.example.com"), {
    withheld: "unreadable",
  });
});
