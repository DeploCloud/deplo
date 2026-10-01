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
import { insertEnvVars } from "../app-graph-load";
import { seedApp, seedServer } from "../app-graph-test-helpers";
import { seedDatabase, TRUNCATE_BACKUPS } from "../backup-test-helpers";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { DEPLO_EXPORT_VERSION } from "../../migration/deplo/export-shape";
import { instanceFingerprint } from "../../migration/deplo/instance";
import { __resetExportTrailForTest, exportTeamForMigration } from "./export";
import { ExportRefusedError, openWorkloadData } from "./data-stream";

const USER_NO_REVEAL = "user_no_reveal";
const USER_B = "user_b";
const INTRUDER = "user_intruder";
const T0 = "2026-01-01T00:00:00.000Z";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

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
