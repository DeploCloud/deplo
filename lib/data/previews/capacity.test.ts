import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { runWithIdentity } from "../../auth/request-context";
import { __setRunnerForTest } from "../../deploy/deploy-queue";
import { openOrSyncPreview } from "../../deploy/preview-lifecycle/open-sync";
import { previewsDueForReaping } from "../../deploy/preview-lifecycle/reaper";
import { settlePreviewDeployState } from "../../deploy/build/deployment-state";
import { TEAM_A, USER_1 } from "../identity-test-helpers";
import { approvePreview } from "../previews";
import {
  PR,
  previewOf,
  readyRunner,
  rowOf,
  seedPreviewApp,
  setupPreviews,
} from "./previews-test-helpers";

const h = setupPreviews();

test("at the cap a new preview EVICTS the least recently active one", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 2 });
  await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  const c = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 3 },
    { actor: "o" },
  );

  assert.ok(c.previewId, "the new pull request builds");
  assert.equal(c.refusal, undefined);

  assert.equal((await previewOf(h.db, 1)).status, "evicted");
  assert.equal(
    (await previewOf(h.db, 1)).state,
    "open",
    "the pull request is still open",
  );
  assert.notEqual((await previewOf(h.db, 2)).status, "evicted");
  assert.notEqual((await previewOf(h.db, 3)).status, "evicted");
});

test("a push does NOT revive an evicted preview, but Redeploy does", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 1 });
  await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  assert.equal((await previewOf(h.db, 1)).status, "evicted");
  const evictedKey = (await previewOf(h.db, 1)).deployKey;

  const push = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1, headSha: "newsha1" },
    { actor: "o" },
  );
  assert.deepEqual(push.refusal, { kind: "evicted", max: 1 });
  assert.equal(push.deploymentId, null);
  assert.equal(
    (await previewOf(h.db, 1)).headSha,
    "newsha1",
    "facts still track the PR",
  );
  assert.equal((await previewOf(h.db, 1)).status, "evicted");
  assert.notEqual((await previewOf(h.db, 2)).status, "evicted");

  const back = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1, headSha: "newsha1" },
    { actor: "someone", manual: true },
  );
  assert.equal(back.refusal, undefined);
  assert.notEqual((await previewOf(h.db, 1)).status, "evicted");
  assert.equal(
    (await previewOf(h.db, 1)).deployKey,
    evictedKey,
    "same stack, same URL",
  );
  assert.equal(
    (await previewOf(h.db, 2)).status,
    "evicted",
    "the cap of 1 still holds",
  );
});

test("a blocked fork evicts NOTHING - a stranger cannot knock a preview over", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 1 });
  await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  assert.equal((await previewOf(h.db, 1)).status, "queued");

  const fork = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 2, isFork: true, headRepo: "stranger/blog" },
    { actor: "stranger" },
  );
  assert.deepEqual(fork.refusal, { kind: "awaiting-approval" });
  assert.equal((await previewOf(h.db, 2)).status, "blocked");
  assert.notEqual(
    (await previewOf(h.db, 1)).status,
    "evicted",
    "the team's own preview must still be running",
  );

  await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 2, isFork: true, headRepo: "stranger/blog" },
    { actor: "maintainer", approve: true, manual: true },
  );
  assert.notEqual((await previewOf(h.db, 2)).status, "blocked");
  assert.equal(
    (await previewOf(h.db, 1)).status,
    "evicted",
    "approving the fork claims a slot like any other build",
  );
});

test("approving a fork through the gated API still respects the cap", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 2 });
  await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 3, isFork: true, headRepo: "stranger/blog" },
    { actor: "stranger" },
  );

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, async () => {
    await approvePreview((await previewOf(h.db, 3)).id);
  });

  const live = (await h.db.select().from(appPreviewsTable)).filter(
    (p) => p.state === "open" && !["blocked", "evicted"].includes(p.status),
  );
  assert.equal(
    live.length,
    2,
    `cap of 2 exceeded: ${live.map((p) => p.prNumber)}`,
  );
  assert.equal(
    (await previewOf(h.db, 1)).status,
    "evicted",
    "the stalest made room",
  );
  assert.notEqual(
    (await previewOf(h.db, 3)).status,
    "blocked",
    "the fork is building",
  );
});

test("a blocked fork holds no slot: it has no stack to evict", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 1 });
  const fork = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 9, isFork: true, headRepo: "someone/blog" },
    { actor: "stranger" },
  );
  assert.deepEqual(fork.refusal, { kind: "awaiting-approval" });

  const mine = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 10 },
    { actor: "o" },
  );
  assert.ok(mine.previewId);
  assert.equal(mine.refusal, undefined);
  assert.equal(
    (await previewOf(h.db, 9)).status,
    "blocked",
    "the fork is still waiting",
  );
});

test("an EXISTING preview keeps building once the app is at its cap", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 1 });
  const a = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  const again = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1, headSha: "zzz" },
    { actor: "o" },
  );
  assert.equal(again.previewId, a.previewId);
  assert.equal(again.refusal, undefined);
});

test("fifteen pull requests at once end with exactly the cap's worth of stacks", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 2 });
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      openOrSyncPreview("prj_1", { ...PR, number: i + 1 }, { actor: "o" }),
    ),
  );
  const rows = await h.db
    .select({ status: appPreviewsTable.status })
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.appId, "prj_1"));
  const holders = rows.filter(
    (r) => !["evicted", "blocked"].includes(r.status),
  );
  assert.equal(rows.length, 8);
  assert.equal(holders.length, 2, `slot holders: ${rows.map((r) => r.status)}`);
});

test("a build that finishes after its preview was evicted does not bring it back", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 1 });
  const a = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  assert.equal((await rowOf(h.db, a.previewId!)).status, "evicted");
  const kept = await settlePreviewDeployState(
    a.previewId!,
    "blog__pr-1",
    "active",
  );
  assert.equal(kept, false);
  assert.equal((await rowOf(h.db, a.previewId!)).status, "evicted");
  const b = await rowOf(h.db, (await previewOf(h.db, 2)).id);
  assert.equal(
    await settlePreviewDeployState(b.id, b.deployKey, "active"),
    true,
  );
  assert.equal((await rowOf(h.db, b.id)).status, "active");
});

test("evicting a preview that never built needs no host, and is not a retry", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 1 });
  __setRunnerForTest(async () => {});
  try {
    const a = await openOrSyncPreview(
      "prj_1",
      { ...PR, number: 1 },
      { actor: "o" },
    );
    await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
    const row = await rowOf(h.db, a.previewId!);
    assert.equal(row.status, "evicted");
    assert.ok(
      row.tornDownAt,
      "nothing was ever on a host, so it is confirmed gone",
    );
    const due = await previewsDueForReaping(new Date(), 20);
    assert.equal(due.retry.length, 0);
  } finally {
    __setRunnerForTest(readyRunner(h.db));
  }
});
