import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { closePreview } from "../../deploy/preview-lifecycle/close";
import { deployPreviewRow } from "../../deploy/preview-lifecycle/deploy";
import { openOrSyncPreview } from "../../deploy/preview-lifecycle/open-sync";
import { previewsDueForReaping } from "../../deploy/preview-lifecycle/reaper";
import { settlePreviewDeployState } from "../../deploy/build/deployment-state";
import {
  PR,
  deploymentsOf,
  rowOf,
  seedPreviewApp,
  setupPreviews,
} from "./previews-test-helpers";

const h = setupPreviews();

test("previews off means no row and no build", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  await h.db
    .update(appsTable)
    .set({ previewEnabled: false })
    .where(eq(appsTable.id, "prj_1"));
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  assert.deepEqual(res.refusal, { kind: "previews-off" });
  assert.equal(res.previewId, null);
});

test("closing twice is idempotent and does not move closedAt", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  await closePreview(res.previewId!, "first");
  const first = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  await closePreview(res.previewId!, "second");
  const second = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(second.closedAt, first.closedAt);
});

test("reopening a closed pull request revives the SAME preview and host", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  const host = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!.host;
  await closePreview(res.previewId!, "closed");
  await h.db
    .update(appPreviewsTable)
    .set({ tornDownAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(appPreviewsTable.id, res.previewId!));

  const again = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  assert.equal(again.previewId, res.previewId);
  const row = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(row.state, "open");
  assert.equal(row.host, host);
  assert.ok(row.tornDownAt);
  assert.equal(
    await settlePreviewDeployState(row.id, row.deployKey, "building"),
    true,
  );
  assert.equal((await rowOf(h.db, row.id)).tornDownAt, null);
});

test("a reopened preview evicted before its build starts needs no host", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 1 });
  const a = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  await h.db
    .update(appPreviewsTable)
    .set({ tornDownAt: "2026-01-01T00:00:00.000Z", state: "closed" })
    .where(eq(appPreviewsTable.id, a.previewId!));
  await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  assert.equal((await rowOf(h.db, a.previewId!)).state, "open");
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  const row = await rowOf(h.db, a.previewId!);
  assert.equal(row.status, "evicted");
  assert.ok(row.tornDownAt, "nothing came back up, so nothing is owed");
  const due = await previewsDueForReaping(new Date(), 20);
  assert.ok(!due.retry.some((r) => r.id === a.previewId));
});

test("a facts-only sync records the head and builds nothing", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const first = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  const builds = (await deploymentsOf(h.db, first.previewId!)).length;

  const synced = await openOrSyncPreview(
    "prj_1",
    { ...PR, headSha: "feedface", title: "Renamed" },
    { actor: "o", build: false },
  );
  assert.equal(synced.previewId, first.previewId);
  assert.equal(synced.deploymentId, null);
  assert.equal(synced.refusal, undefined);
  const row = await rowOf(h.db, first.previewId!);
  assert.equal(row.headSha, "feedface");
  assert.equal(row.prTitle, "Renamed");
  assert.equal((await deploymentsOf(h.db, first.previewId!)).length, builds);
});

test("a facts-only sync never creates a row and never reopens a closed one", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const none = await openOrSyncPreview("prj_1", PR, {
    actor: "o",
    build: false,
  });
  assert.equal(none.previewId, null);
  assert.equal((await h.db.select().from(appPreviewsTable)).length, 0);

  const opened = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  await closePreview(opened.previewId!, "closed");
  await openOrSyncPreview(
    "prj_1",
    { ...PR, title: "Edited after close" },
    { actor: "o", build: false },
  );
  const row = await rowOf(h.db, opened.previewId!);
  assert.equal(row.state, "closed", "a title edit does not reopen anything");
  assert.equal(row.prTitle, "Edited after close");
});

test("a deploy refused before it was queued leaves the row in error, not queued", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const a = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  await h.db
    .update(appsTable)
    .set({ migrationRunId: "mig_1" })
    .where(eq(appsTable.id, "prj_1"));
  await assert.rejects(
    () => deployPreviewRow(a.previewId!, { actor: "o" }),
    /migration/,
  );
  assert.equal((await rowOf(h.db, a.previewId!)).status, "error");
});
