import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { closePreview } from "../../deploy/preview-lifecycle/close";
import { deployPreviewRow } from "../../deploy/preview-lifecycle/deploy";
import { openOrSyncPreview } from "../../deploy/preview-lifecycle/open-sync";
import {
  previewsDueForReaping,
  pruneClosedPreviews,
  retryPreviewTeardown,
} from "../../deploy/preview-lifecycle/reaper";
import { seedPreview } from "../app-graph-test-helpers";
import {
  PR,
  rowOf,
  seedPreviewApp,
  setupPreviews,
} from "./previews-test-helpers";

const h = setupPreviews();

test("a close that could not reach the host stays queued for the reaper", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  const gone = await closePreview(res.previewId!, "pull request closed");
  assert.equal(gone, false);

  const row = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(row.state, "closed");
  assert.equal(
    row.tornDownAt,
    null,
    "the only honest record that a stack is still out there",
  );
  assert.ok(row.closedAt);

  const due = await previewsDueForReaping(new Date(), 20);
  assert.deepEqual(
    due.retry.map((r) => r.id),
    [res.previewId],
  );
});

test("an idle preview is reaped, a fresh one is not", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const fresh = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  const stale = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 2 },
    { actor: "o" },
  );
  await h.db
    .update(appPreviewsTable)
    .set({ lastActivityAt: "2020-01-01T00:00:00.000Z" })
    .where(eq(appPreviewsTable.id, stale.previewId!));

  const due = await previewsDueForReaping(new Date(), 20);
  assert.deepEqual(
    due.expired.map((r) => r.id),
    [stale.previewId],
  );
  assert.ok(!due.expired.some((r) => r.id === fresh.previewId));
});

test("the reaper retries an evicted stack the host never confirmed gone", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 1 });
  const a = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  assert.equal((await rowOf(h.db, a.previewId!)).status, "evicted");
  assert.equal((await rowOf(h.db, a.previewId!)).tornDownAt, null);

  let due = await previewsDueForReaping(new Date(), 20);
  assert.deepEqual(
    due.retry.map((r) => r.id),
    [a.previewId],
  );

  await h.db
    .update(appPreviewsTable)
    .set({ tornDownAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(appPreviewsTable.id, a.previewId!));
  await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1, headSha: "newsha" },
    { actor: "o" },
  );
  assert.ok(
    (await rowOf(h.db, a.previewId!)).tornDownAt,
    "still confirmed gone",
  );
  due = await previewsDueForReaping(new Date(), 20);
  assert.equal(due.retry.length, 0);
});

test("a fork that never built is not a teardown to retry", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const fork = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "mallory/blog" },
    { actor: "mallory" },
  );
  assert.equal((await rowOf(h.db, fork.previewId!)).status, "blocked");
  const due = await previewsDueForReaping(new Date(), 20);
  assert.equal(due.retry.length, 0);
});

test("a retry picked up by the reaper is skipped once the preview was revived", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 1 });
  const a = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  await deployPreviewRow(a.previewId!, { actor: "someone" });
  assert.equal((await rowOf(h.db, a.previewId!)).status, "queued");
  assert.equal(
    await retryPreviewTeardown(a.previewId!),
    false,
    "must not tear down the stack being built",
  );
});

test("a closed pull request keeps its row for a week, then only if its stack is unconfirmed", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const now = new Date("2026-09-05T12:00:00.000Z");
  const old = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString();
  const recent = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString();
  const seed = (
    id: string,
    prNumber: number,
    closedAt: string,
    torn: boolean,
  ) =>
    seedPreview(h.db, {
      id,
      appId: "prj_1",
      prNumber,
      state: "closed",
      closedAt,
      tornDownAt: torn ? closedAt : null,
    });
  await seed("prv_old_gone", 1, old, true);
  await seed("prv_old_stuck", 2, old, false);
  await seed("prv_recent", 3, recent, true);
  await seedPreview(h.db, { id: "prv_open", appId: "prj_1", prNumber: 4 });

  assert.equal(await pruneClosedPreviews(now, 50), 1);
  const left = (await h.db.select().from(appPreviewsTable)).map((r) => r.id);
  assert.deepEqual(left.sort(), ["prv_old_stuck", "prv_open", "prv_recent"]);
});
