import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { TEAM_A } from "../identity-test-helpers";
import { seedRun, seedS3 } from "../backup-test-helpers";
import { asUser1, seedBase, USER_RESTORER } from "./backups-test-helpers";
import { downloadBackupArtifact } from "./download";

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

beforeEach(() => seedBase(db, pg));

test("a bucket artifact is no longer refused: the download reaches the agent", async () => {
  await asUser1(async () => {
    await seedRun(db, {
      id: "brun_dl",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
    });
    await assert.rejects(
      () => downloadBackupArtifact("brun_dl"),
      (e: Error) => {
        assert.doesNotMatch(e.message, /in your bucket/i);
        assert.match(e.message, /not provisioned|unreachable|too old/i);
        return true;
      },
    );
  });
});

test("a legacy plaintext bucket destination downloads by the same path", async () => {
  await asUser1(async () => {
    await seedS3(db, { id: "s3_old", legacyPlaintext: true });
    await seedRun(db, {
      id: "brun_old",
      destinationId: "s3_old",
      targetKind: "app",
      appId: "prj_1",
    });
    await assert.rejects(
      () => downloadBackupArtifact("brun_old"),
      (e: Error) => {
        assert.doesNotMatch(e.message, /in your bucket/i);
        return true;
      },
    );
  });
});

test("an artifact whose app was deleted says WHICH server it lacks", async () => {
  await asUser1(async () => {
    await seedRun(db, {
      id: "brun_orphan",
      destinationId: "s3_1",
      targetKind: "app",
      appId: null,
      targetId: "prj_gone",
    });
    await assert.rejects(
      () => downloadBackupArtifact("brun_orphan"),
      /No server on this instance can reach/,
    );
  });
});

test("downloading an APP archive is a reveal: restore_backups alone is refused", async () => {
  await asUser1(() =>
    seedRun(db, {
      id: "brun_app",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
    }),
  );
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_RESTORER, teamId: TEAM_A }, () =>
        downloadBackupArtifact("brun_app"),
      ),
    /reveal secret values/i,
  );
});
