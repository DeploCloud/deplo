// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  foldRuns,
  mentionAt,
  monthKey,
  stamp,
  type ActivityItem,
} from "./activity-timeline";

function row(over: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    type: "deployment",
    message: "Deploying docs",
    actor: "IdraDev",
    actorUser: null,
    actorProvider: null,
    createdAt: "2026-08-26T14:32:11.000Z",
    appId: "prj_api",
    databaseId: null,
    cursor: `${over.createdAt ?? "2026-08-26T14:32:11.000Z"}|1`,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* stamp                                                               */
/* ------------------------------------------------------------------ */

test("stamp reads the ISO string in UTC, so no clock can disagree with it", () => {
  assert.equal(stamp("2026-08-26T14:32:11.000Z"), "26 Aug, 14:32");
  assert.equal(stamp("2026-01-02T00:05:00.000Z"), "2 Jan, 00:05");
  // The month heading above the row carries the year, so the row does not.
  assert.equal(stamp("2025-12-31T23:59:00.000Z"), "31 Dec, 23:59");
  assert.equal(stamp("not a date"), "");
});

/* ------------------------------------------------------------------ */
/* mentionAt                                                           */
/* ------------------------------------------------------------------ */

test("mentionAt finds the app's name only as a whole word", () => {
  assert.equal(mentionAt("Deployed api to production", "api"), 9);
  // The one that matters: a short name must not light up inside a longer one.
  assert.equal(mentionAt("Deployed api-gateway to production", "api"), -1);
  assert.equal(mentionAt("Deployed api-gateway", "api-gateway"), 9);
  assert.equal(mentionAt("Updated build settings", "api"), -1);
});

test("mentionAt skips a bad boundary and takes the next real one", () => {
  assert.equal(mentionAt("api-gateway restarted; api is fine", "api"), 23);
});

/* ------------------------------------------------------------------ */
/* foldRuns                                                            */
/* ------------------------------------------------------------------ */

test("foldRuns folds a consecutive run by one person into one entry", () => {
  const runs = foldRuns([
    row({ id: "a", createdAt: "2026-08-26T16:00:00.000Z" }),
    row({ id: "b", createdAt: "2026-08-26T15:00:00.000Z" }),
    row({ id: "c", createdAt: "2026-08-26T14:00:00.000Z" }),
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.item.id, "a", "the newest row leads");
  assert.deepEqual(runs[0]!.times, [
    "2026-08-26T16:00:00.000Z",
    "2026-08-26T15:00:00.000Z",
    "2026-08-26T14:00:00.000Z",
  ]);
});

test("foldRuns keeps a different person, message, app or database apart", () => {
  const runs = foldRuns([
    row({ id: "a" }),
    row({ id: "b", actor: "Grace Hopper" }),
    row({ id: "c", message: "Stopping docs" }),
    row({ id: "d", appId: "prj_web" }),
  ]);
  assert.deepEqual(
    runs.map((r) => r.item.id),
    ["a", "b", "c", "d"],
  );
});

test("foldRuns keeps two databases apart under one message", () => {
  // "Restarted database x" is the same sentence for every database, so without
  // the id two of them would collapse into one row that names only the first.
  const dbRow = (id: string, databaseId: string) =>
    row({
      id,
      type: "database",
      message: "Restarted database db",
      appId: null,
      databaseId,
    });
  const runs = foldRuns([
    dbRow("a", "db_1"),
    dbRow("b", "db_2"),
    dbRow("c", "db_2"),
  ]);
  assert.deepEqual(
    runs.map((r) => [r.item.id, r.times.length]),
    [
      ["a", 1],
      ["b", 2],
    ],
  );
});

test("foldRuns only folds NEIGHBOURS, so the trail keeps its order", () => {
  const runs = foldRuns([
    row({ id: "a" }),
    row({ id: "b", actor: "Grace Hopper" }),
    row({ id: "c" }),
  ]);
  assert.deepEqual(
    runs.map((r) => [r.item.id, r.times.length]),
    [
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ],
  );
});

test("foldRuns never folds across a month heading", () => {
  const runs = foldRuns([
    row({ id: "a", createdAt: "2026-08-01T09:00:00.000Z" }),
    row({ id: "b", createdAt: "2026-07-31T23:00:00.000Z" }),
  ]);
  assert.equal(runs.length, 2, "a run may not span two headings");
  assert.notEqual(
    monthKey(runs[0]!.item.createdAt),
    monthKey(runs[1]!.item.createdAt),
  );
});
