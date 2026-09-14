import { test } from "node:test";
import assert from "node:assert/strict";

import {
  APP_IN_PRC,
  APP_OUT_PRC,
  DEV,
  PRC_IN,
  as,
  scopeTo,
  setupRoleScope,
} from "./role-scope-test-helpers";

const h = setupRoleScope();

test("a backup schedule is reachable only through the app it belongs to", async () => {
  const { seedBackup, seedDatabase, seedS3 } =
    await import("../backup-test-helpers");
  const { listBackups, toggleBackup } = await import("../backups/schedules");
  await seedDatabase(h.db, { id: "db_main", name: "main" });
  await seedS3(h.db, { id: "s3_main" });
  await seedBackup(h.db, {
    id: "bk_out",
    targetKind: "app",
    appId: APP_OUT_PRC,
    destinationId: "s3_main",
  });
  await seedBackup(h.db, {
    id: "bk_db",
    databaseId: "db_main",
    destinationId: "s3_main",
  });

  await scopeTo(h, { projects: [PRC_IN] });
  await h.pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'manage_backups' from memberships where user_id = '${DEV}'`,
  );

  assert.deepEqual(
    (await as(DEV, () => listBackups())).map((b) => b.id),
    [],
    "the schedules of an app they can't reach, and of a database, are not theirs",
  );
  // `manage_backups` survives the clamp because it means something on an app, so the
  // team-wide capability check alone would have let this through.
  await assert.rejects(
    () => as(DEV, () => toggleBackup("bk_db", false)),
    /not found/i,
  );
  await assert.rejects(
    () => as(DEV, () => toggleBackup("bk_out", false)),
    /not found/i,
  );
});

test("a backup RUN history is reachable only through the app it belongs to", async () => {
  const { seedBackup, seedRun, seedS3 } =
    await import("../backup-test-helpers");
  const { listBackupRuns } = await import("../backups/run-listing");
  const { countBackupArtifacts, backupDestinationsForTarget } =
    await import("../backups/artifact-delete");
  await seedS3(h.db, { id: "s3_main" });
  await seedBackup(h.db, {
    id: "bk_out",
    targetKind: "app",
    appId: APP_OUT_PRC,
    destinationId: "s3_main",
  });
  await seedBackup(h.db, {
    id: "bk_in",
    targetKind: "app",
    appId: APP_IN_PRC,
    destinationId: "s3_main",
  });
  // Real out-of-scope data to leak: a probe against an empty table proves nothing, and
  // asserting on one is how this shipped.
  await seedRun(h.db, {
    id: "run_in",
    targetKind: "app",
    appId: APP_IN_PRC,
    backupId: "bk_in",
    destinationId: "s3_main",
  });
  await seedRun(h.db, {
    id: "run_out",
    targetKind: "app",
    appId: APP_OUT_PRC,
    backupId: "bk_out",
    destinationId: "s3_main",
  });

  await scopeTo(h, { projects: [PRC_IN] });
  await h.pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'manage_backups' from memberships where user_id = '${DEV}'`,
  );

  // The control FIRST, or a gate that simply refuses everything would pass this test.
  assert.deepEqual(
    (await as(DEV, () => listBackupRuns({ appId: APP_IN_PRC }))).map(
      (r) => r.id,
    ),
    ["run_in"],
  );
  // `backupTargetInScope` used to fall through to `appInTeam`, whose only scope clause reads
  // `narrowedScope()` - the TOKEN's reach, null for this session, so the run row leaked.
  assert.deepEqual(
    await as(DEV, () => listBackupRuns({ appId: APP_OUT_PRC })),
    [],
    "the run history of an app outside the scope leaked",
  );
  assert.equal(
    await as(DEV, () =>
      countBackupArtifacts({ kind: "app", targetId: APP_OUT_PRC }),
    ),
    0,
  );
  assert.deepEqual(
    await as(DEV, () =>
      backupDestinationsForTarget({ kind: "app", targetId: APP_OUT_PRC }),
    ),
    [],
  );
});
