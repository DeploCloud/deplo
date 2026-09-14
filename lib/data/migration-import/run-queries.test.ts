import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { runWithIdentity } from "../../auth/request-context";
import { TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { revertMigration, stopMigration } from "./revert";
import { beginMigration, finishMigration } from "./run-lifecycle";
import {
  dismissMigrationReport,
  resumableMigration,
  resumableMigrationAnywhere,
  listAllMigrationRuns,
  listMigrationRuns,
} from "./run-queries";
import { activeMigrationStream } from "../../graphql/types/migration/active-run-feed";
import {
  URL_BASE,
  asOwner,
  asMember,
  importProject,
  inBothTeams,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

test("the wizard opens on the run you left, until you close its report", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));

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

  assert.equal(
    (await asOwner(() => resumableMigration()))?.id,
    runId,
    "a run in flight must reach every member of the team, not only its actor",
  );

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

test("the live stream follows a run from start to finish, team-scoped", async () => {
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
  assert.equal(
    started.value?.heartbeatAt,
    null,
    "a run no runner has claimed must not look like one in flight",
  );

  assert.equal((await activeMigrationStream(TEAM_B).next()).value, null);

  const ending = gen.next();
  await asOwner(() => stopMigration(runId));
  assert.equal((await ending).value, null, "a stopped run is not in progress");

  await gen.return(undefined as never);
});

test("a finished run stays on the feed until its report is closed", async () => {
  const gen = activeMigrationStream(TEAM_A);
  await gen.next();
  const pending = gen.next();
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  assert.equal((await pending).value?.status, "running");

  const finishing = gen.next();
  await asOwner(() => finishMigration(runId));
  const finished = (await finishing).value;
  assert.equal(finished?.id, runId);
  assert.equal(finished?.status, "done");

  const closing = gen.next();
  await asOwner(() => dismissMigrationReport(runId));
  assert.equal((await closing).value, null, "closing the report clears it");

  await gen.return(undefined as never);
});

test("the instance's history lists every team's runs, with the team each landed in", async () => {
  await inBothTeams(db, "mem_1_b", USER_1, ["view", "create_projects"]);
  const inA = await asOwner(() => beginMigration({ url: URL_BASE }));
  const inB = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    beginMigration({ url: URL_BASE }),
  );

  const all = await asOwner(() => listAllMigrationRuns());
  assert.deepEqual(
    all.map((r) => [r.id, r.teamId, r.teamSlug]).sort(),
    [
      [inA, TEAM_A, "alpha"],
      [inB, TEAM_B, "beta"],
    ].sort(),
  );
  assert.deepEqual(
    (await asOwner(() => listMigrationRuns())).map((r) => r.id),
    [inA],
  );
  await assert.rejects(() => asMember(() => listAllMigrationRuns()), /admin/i);
});

test("the wizard opens on the run you left, whichever team it landed in", async () => {
  await inBothTeams(db, "mem_1_b", USER_1, ["view", "create_projects"]);
  const inB = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    beginMigration({ url: URL_BASE }),
  );

  assert.equal(await asOwner(() => resumableMigration()), null);
  const open = await asOwner(() => resumableMigrationAnywhere());
  assert.equal(open?.id, inB);
  assert.equal(open?.teamId, TEAM_B);

  await db.execute(
    `update migration_runs set status = 'done' where id = '${inB}'`,
  );
  await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    dismissMigrationReport(inB),
  );
  assert.equal(await asOwner(() => resumableMigrationAnywhere()), null);
});
