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
import type { BackupRun } from "../types";

/**
 * The object-key + extension helpers are the contract the bucket layout and
 * retention pruning both depend on: a key must be stable, unique per run,
 * URL-safe, and reduce to a per-target prefix that `S3Delete(prefix)` can sweep.
 */

test("artifactExt maps each engine to its dump format", () => {
  assert.equal(artifactExt("database", "postgres"), "dump.gz");
  assert.equal(artifactExt("database", "mysql"), "sql.gz");
  assert.equal(artifactExt("database", "mariadb"), "sql.gz");
  assert.equal(artifactExt("database", "clickhouse"), "sql.gz");
  assert.equal(artifactExt("database", "mongodb"), "archive.gz");
  assert.equal(artifactExt("database", "redis"), "rdb.gz");
  assert.equal(artifactExt("app"), "tar.gz");
});

test("artifactExt falls back to .gz for an unknown engine", () => {
  // @ts-expect-error — deliberately exercising the defensive default arm.
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
    "deplo/team_1/service/prj_2/",
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
  assert.equal(key, "deplo/team_1/database/db_9/20260623T174511Z-brun_abc.dump.gz");
  // The key must live under the retention prefix so a prefix-delete sweeps it.
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

/* ------------------------------------------------------------------ */
/* Retention selection                                                 */
/* ------------------------------------------------------------------ */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-23T00:00:00.000Z");

/** A success run started `daysAgo` before NOW. */
const run = (id: string, daysAgo: number, over: Partial<BackupRun> = {}): BackupRun => ({
  id,
  teamId: "t",
  backupId: null,
  targetKind: "database",
  databaseId: "db_1",
  appId: null,
  destinationId: "s3_1",
  objectKey: `deplo/t/database/db_1/${id}.dump.gz`,
  sizeBytes: 100,
  status: "success",
  error: null,
  startedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  finishedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  ...over,
});

test("retention: runs older than the window are doomed", () => {
  const runs = [run("a", 0), run("b", 5), run("c", 10)];
  const doomed = selectDoomedRuns(runs, { retentionDays: 7, maxPerTarget: 50, now: NOW });
  assert.deepEqual(doomed.map((r) => r.id), ["c"]); // only the 10-day-old one
});

test("retention: the newest successful run is ALWAYS kept, even past the window", () => {
  // Every run is older than the window — but the newest success survives so the
  // target is never left with zero restorable artifacts.
  const runs = [run("a", 30), run("b", 40), run("c", 50)];
  const doomed = selectDoomedRuns(runs, { retentionDays: 7, maxPerTarget: 50, now: NOW });
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["b", "c"]); // "a" (newest) kept
});

test("retention: a running run is never pruned", () => {
  const runs = [run("a", 0), run("old-running", 99, { status: "running" })];
  const doomed = selectDoomedRuns(runs, { retentionDays: 7, maxPerTarget: 50, now: NOW });
  assert.deepEqual(doomed, []);
});

test("retention: failed runs past the window are pruned (they own no object)", () => {
  const runs = [
    run("ok", 0),
    run("failA", 20, { status: "failed", objectKey: "", sizeBytes: 0 }),
    run("failB", 25, { status: "failed", objectKey: "", sizeBytes: 0 }),
  ];
  const doomed = selectDoomedRuns(runs, { retentionDays: 7, maxPerTarget: 50, now: NOW });
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["failA", "failB"]);
});

test("retention: the per-target count cap prunes the oldest beyond the cap", () => {
  // 5 fresh runs (all within the window), cap of 3 → the 2 oldest are doomed by
  // the cap even though none is past the age window.
  const runs = [run("r0", 0), run("r1", 1), run("r2", 2), run("r3", 3), run("r4", 4)];
  const doomed = selectDoomedRuns(runs, { retentionDays: 365, maxPerTarget: 3, now: NOW });
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["r3", "r4"]);
});

test("retention: nothing to prune within window and under cap", () => {
  const runs = [run("a", 0), run("b", 1), run("c", 2)];
  const doomed = selectDoomedRuns(runs, { retentionDays: 7, maxPerTarget: 50, now: NOW });
  assert.deepEqual(doomed, []);
});

/* ------------------------------------------------------------------ */
/* Retention seq tiebreak (PLAN §5) — same-millisecond runs               */
/* ------------------------------------------------------------------ */

/** Two runs at the SAME instant, ordered only by their DB `seq`. */
const sameMsRun = (
  id: string,
  seq: number,
  over: Partial<BackupRun> = {},
): RunForRetention => ({ ...run(id, 30), seq, ...over });

test("retention: a same-ms tie keeps the higher-seq success (newest), prunes the rest", () => {
  // Three successes ALL at the same (old) instant: timestamp alone can't order
  // them, so without seq the "newest success to keep" is non-deterministic and
  // could delete the live object. With seq, the highest-seq run is newest.
  const runs = [sameMsRun("low", 1), sameMsRun("mid", 2), sameMsRun("high", 3)];
  const doomed = selectDoomedRuns(runs, { retentionDays: 7, maxPerTarget: 50, now: NOW });
  // "high" (seq 3) is the kept newest success; the two older same-ms runs are doomed.
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["low", "mid"]);
});

test("retention: same-ms tiebreak is independent of input array order", () => {
  // Same three runs, shuffled — seq, not array position, decides "newest".
  const runs = [sameMsRun("mid", 2), sameMsRun("high", 3), sameMsRun("low", 1)];
  const doomed = selectDoomedRuns(runs, { retentionDays: 7, maxPerTarget: 50, now: NOW });
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["low", "mid"]);
});

test("retention: the cap counts newest-first by (startedAt, seq) under a tie", () => {
  // Five same-instant runs, cap 2 → the 2 newest (highest seq) survive the cap,
  // plus the kept-newest rule overlaps with the highest. Deterministic via seq.
  const runs = [
    sameMsRun("s1", 1), sameMsRun("s2", 2), sameMsRun("s3", 3),
    sameMsRun("s4", 4), sameMsRun("s5", 5),
  ];
  const doomed = selectDoomedRuns(runs, { retentionDays: 365, maxPerTarget: 2, now: NOW });
  // newest-first = s5,s4,s3,s2,s1; idx>=2 (s3,s2,s1) are over the cap.
  assert.deepEqual(doomed.map((r) => r.id).sort(), ["s1", "s2", "s3"]);
});
