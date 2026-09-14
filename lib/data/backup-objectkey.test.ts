import { test } from "node:test";
import assert from "node:assert/strict";

import {
  artifactExt,
  objectStamp,
  targetPrefix,
  buildObjectKey,
  selectDoomedRuns,
  type RunForRetention,
} from "./backup-objectkey";
import type { BackupRun } from "../types/backup";

test("artifactExt maps each engine to its dump format", () => {
  assert.equal(artifactExt("database", "postgres"), "dump.gz");
  assert.equal(artifactExt("database", "mysql"), "sql.gz");
  assert.equal(artifactExt("database", "mariadb"), "sql.gz");
  assert.equal(artifactExt("database", "clickhouse"), "sql.gz");
  assert.equal(artifactExt("database", "mongodb"), "archive.gz");
  assert.equal(artifactExt("database", "redis"), "rdb.gz");
  assert.equal(artifactExt("app"), "tar.gz");
});

test("an encrypted artifact is named .age; a plaintext one is unchanged", () => {
  assert.equal(artifactExt("app", null, true), "tar.gz.age");
  assert.equal(artifactExt("database", "postgres", true), "dump.gz.age");
  assert.equal(artifactExt("database", "redis", true), "rdb.gz.age");
  assert.equal(artifactExt("app", null, false), "tar.gz");
  assert.equal(artifactExt("app", null), "tar.gz");
  assert.equal(artifactExt("app"), "tar.gz");
});

test("artifactExt falls back to .gz for an unknown engine", () => {
  // @ts-expect-error - deliberately exercising the defensive default arm.
  assert.equal(artifactExt("database", "cassandra"), "gz");
  assert.equal(artifactExt("database", null), "gz");
});

test("objectStamp is colon-free, millis-free UTC", () => {
  const stamp = objectStamp(new Date("2026-06-23T17:45:11.123Z"));
  assert.equal(stamp, "20260623T174511Z");
  assert.ok(!stamp.includes(":"));
  assert.ok(!stamp.includes("."));
});

test("targetPrefix is the per-target folder and ends in a slash", () => {
  assert.equal(
    targetPrefix("team_1", "database", "db_9"),
    "deplo/team_1/database/db_9/",
  );
  assert.equal(
    targetPrefix("team_1", "app", "prj_2"),
    "deplo/team_1/app/prj_2/",
  );
});

test("buildObjectKey nests under the target prefix, stamped + run-suffixed", () => {
  const key = buildObjectKey({
    teamId: "team_1",
    kind: "database",
    targetId: "db_9",
    runId: "brun_abc",
    ext: "dump.gz",
    at: new Date("2026-06-23T17:45:11.000Z"),
  });
  assert.equal(
    key,
    "deplo/team_1/database/db_9/20260623T174511Z-brun_abc.dump.gz",
  );
  assert.ok(key.startsWith(targetPrefix("team_1", "database", "db_9")));
});

test("two runs of one target in the same second get distinct keys", () => {
  const at = new Date("2026-06-23T17:45:11.000Z");
  const base = {
    teamId: "t",
    kind: "app" as const,
    targetId: "prj_1",
    ext: "tar.gz",
    at,
  };
  const a = buildObjectKey({ ...base, runId: "brun_a" });
  const b = buildObjectKey({ ...base, runId: "brun_b" });
  assert.notEqual(a, b);
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-23T00:00:00.000Z");

const run = (
  id: string,
  daysAgo: number,
  over: Partial<BackupRun> = {},
): BackupRun => ({
  id,
  teamId: "t",
  backupId: null,
  targetKind: "database",
  databaseId: "db_1",
  appId: null,
  destinationId: "s3_1",
  targetId: "db_1",
  objectKey: `deplo/t/database/db_1/${id}.dump.gz`,
  sizeBytes: 100,
  decryptedSizeBytes: null,
  sha256: null,
  orphanedAt: null,
  status: "success",
  error: null,
  startedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  finishedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  ...over,
});

const opts = (keepLast: number, maxRecords = 50) => ({ keepLast, maxRecords });

test("retention: keeps the newest N successful runs and dooms the rest", () => {
  const runs = [run("a", 0), run("b", 1), run("c", 2), run("d", 3)];
  const doomed = selectDoomedRuns(runs, opts(2));
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["c", "d"]);
});

test("retention: nothing to prune while under the count", () => {
  const runs = [run("a", 0), run("b", 1), run("c", 2)];
  assert.deepEqual(selectDoomedRuns(runs, opts(3)), []);
});

test("retention: age is irrelevant - old runs survive if they are within the count", () => {
  const runs = [run("a", 365), run("b", 400), run("c", 500)];
  assert.deepEqual(selectDoomedRuns(runs, opts(3)), []);
});

test("retention: the newest successful run is ALWAYS kept", () => {
  // keepLast is clamped to >= 1 by the data layer, so a target can never be left
  // with zero restorable artifacts.
  const runs = [run("a", 0), run("b", 1), run("c", 2)];
  const doomed = selectDoomedRuns(runs, opts(1));
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["b", "c"]);
});

test("retention: a running run is never pruned, and does not use up a slot", () => {
  const runs = [
    run("in-flight", 0, { status: "running", objectKey: "", sizeBytes: 0 }),
    run("a", 1),
    run("b", 2),
  ];
  assert.deepEqual(selectDoomedRuns(runs, opts(2)), []);
});

test("retention: FAILED runs do not evict a kept success", () => {
  // The regression this rule exists for: three bad nights in a row must not silently
  // delete the three good backups "keep the last 3" promised.
  const failed = (id: string, daysAgo: number) =>
    run(id, daysAgo, {
      status: "failed" as const,
      objectKey: "",
      sizeBytes: 0,
    });
  const runs = [
    failed("f1", 0),
    failed("f2", 1),
    failed("f3", 2),
    run("ok1", 3),
    run("ok2", 4),
    run("ok3", 5),
  ];
  assert.deepEqual(selectDoomedRuns(runs, opts(3)), []);
});

test("retention: failed runs are bounded by the record cap, not by the count", () => {
  const failed = (id: string, daysAgo: number) =>
    run(id, daysAgo, {
      status: "failed" as const,
      objectKey: "",
      sizeBytes: 0,
    });
  const runs = [
    failed("f1", 0),
    failed("f2", 1),
    failed("f3", 2),
    run("ok", 3),
  ];
  const doomed = selectDoomedRuns(runs, opts(3, 2));
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["f3"]);
});

const sameMsRun = (
  id: string,
  seq: number,
  over: Partial<BackupRun> = {},
): RunForRetention => ({ ...run(id, 30), seq, ...over });

test("retention: a same-ms tie keeps the higher-seq success (newest), prunes the rest", () => {
  // All at the same instant: without seq the "newest success to keep" is
  // non-deterministic and could delete the live object.
  const runs = [sameMsRun("low", 1), sameMsRun("mid", 2), sameMsRun("high", 3)];
  const doomed = selectDoomedRuns(runs, opts(1));
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["low", "mid"]);
});

test("retention: same-ms tiebreak is independent of input array order", () => {
  const runs = [sameMsRun("mid", 2), sameMsRun("high", 3), sameMsRun("low", 1)];
  const doomed = selectDoomedRuns(runs, opts(1));
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["low", "mid"]);
});

test("retention: the count walks newest-first by (startedAt, seq) under a tie", () => {
  const runs = [
    sameMsRun("s1", 1),
    sameMsRun("s2", 2),
    sameMsRun("s3", 3),
    sameMsRun("s4", 4),
    sameMsRun("s5", 5),
  ];
  const doomed = selectDoomedRuns(runs, opts(2));
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["s1", "s2", "s3"]);
});
