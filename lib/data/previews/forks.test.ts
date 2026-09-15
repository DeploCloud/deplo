import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  appPreviews as appPreviewsTable,
  deployments as deploymentsTable,
} from "../../db/schema/control-plane/deployments";
import { runWithIdentity } from "../../auth/request-context";
import { openOrSyncPreview } from "../../deploy/preview-lifecycle/open-sync";
import { previewsDueForReaping } from "../../deploy/preview-lifecycle/reaper";
import { TEAM_A, USER_1 } from "../identity-test-helpers";
import { redeployPreview } from "../previews";
import {
  PR,
  deploymentsOf,
  rowOf,
  seedPreviewApp,
  setupPreviews,
} from "./previews-test-helpers";

const h = setupPreviews();

test("a fork's pull request is recorded but builds nothing", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const res = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "mallory/blog" },
    { actor: "mallory" },
  );
  assert.ok(res.previewId, "it must be VISIBLE so a maintainer can approve it");
  assert.deepEqual(res.refusal, { kind: "awaiting-approval" });
  assert.equal(res.deploymentId, null);

  const row = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(row.status, "blocked");
  assert.equal(row.approvedAt, null);
  assert.equal(row.isFork, true);
});

test("a fork is refused outright while the app reaches the server", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", forkPolicy: "allow" });
  await h.db
    .update(appsTable)
    .set({ hostReachBy: USER_1 })
    .where(eq(appsTable.id, "prj_1"));
  const res = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "mallory/blog" },
    { actor: "mallory" },
  );
  assert.deepEqual(res.refusal, { kind: "fork-host-reach" });
  assert.equal(res.deploymentId, null);
  assert.equal((await h.db.select().from(appPreviewsTable)).length, 0);
  const own = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 2 },
    { actor: "o" },
  );
  assert.equal(own.refusal, undefined);
  assert.ok(own.previewId);
});

test("a fork is refused while the compose hands values out inline", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", forkPolicy: "allow" });
  await h.db
    .update(appsTable)
    .set({
      compose:
        "services:\n  web:\n    image: nginx\n    environment:\n      - SECRET=hunter2\n",
    })
    .where(eq(appsTable.id, "prj_1"));
  const res = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "mallory/blog" },
    { actor: "mallory" },
  );
  assert.deepEqual(res.refusal, { kind: "fork-inline-env" });
  await h.db
    .update(appsTable)
    .set({
      compose:
        "services:\n  web:\n    image: nginx\n    environment:\n      - SECRET\n",
    })
    .where(eq(appsTable.id, "prj_1"));
  const ok = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "mallory/blog" },
    { actor: "mallory" },
  );
  assert.equal(ok.refusal, undefined);
});

test("fork policy `deny` records nothing at all", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", forkPolicy: "deny" });
  const res = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "mallory/blog" },
    { actor: "mallory" },
  );
  assert.equal(res.previewId, null);
  assert.deepEqual(res.refusal, { kind: "fork-denied" });
  const rows = await h.db.select().from(appPreviewsTable);
  assert.equal(rows.length, 0);
});

test("fork policy `allow` builds a fork like any other pull request", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", forkPolicy: "allow" });
  const res = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "friend/blog" },
    { actor: "friend" },
  );
  assert.ok(res.previewId);
  assert.equal(res.refusal, undefined);
});

test("a fork approved at one commit is blocked again by the next push", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const fork = { ...PR, isFork: true, headRepo: "mallory/blog" };

  const first = await openOrSyncPreview("prj_1", fork, { actor: "mallory" });
  assert.deepEqual(first.refusal, { kind: "awaiting-approval" });

  const approved = await openOrSyncPreview("prj_1", fork, {
    actor: "maintainer",
    approve: true,
    manual: true,
  });
  assert.equal(approved.refusal, undefined, "the reviewed commit builds");

  const pushed = await openOrSyncPreview(
    "prj_1",
    { ...fork, headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    { actor: "mallory" },
  );
  assert.deepEqual(
    pushed.refusal,
    { kind: "awaiting-approval" },
    "a commit nobody reviewed must not inherit the approval",
  );
  assert.equal(pushed.deploymentId, null, "and must not build");

  const row = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, first.previewId!))
  )[0]!;
  assert.equal(row.status, "blocked");
  assert.equal(
    row.approvedSha,
    PR.headSha,
    "the approval still names the commit it was given for",
  );
});

test("a manual-only fork push withdraws the approval for the new commit", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const fork = { ...PR, isFork: true, headRepo: "mallory/blog" };
  const approved = await openOrSyncPreview("prj_1", fork, {
    actor: "maintainer",
    approve: true,
    manual: true,
  });
  assert.equal(approved.refusal, undefined);

  const pushed = await openOrSyncPreview(
    "prj_1",
    { ...fork, headSha: "deadbeef" },
    { actor: "mallory", build: false },
  );
  assert.deepEqual(pushed.refusal, { kind: "awaiting-approval" });
  const row = await rowOf(h.db, approved.previewId!);
  assert.equal(row.status, "blocked");
  assert.equal(row.headSha, "deadbeef");
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    assert.rejects(
      () => redeployPreview(approved.previewId!),
      /approve this fork/i,
      "Redeploy must not build the commit nobody reviewed",
    ),
  );
});

test("an unreviewed commit takes the fork's running stack down", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const fork = { ...PR, isFork: true, headRepo: "mallory/blog" };
  const approved = await openOrSyncPreview("prj_1", fork, {
    actor: "maintainer",
    approve: true,
    manual: true,
  });
  await h.db.insert(deploymentsTable).values({
    id: "dpl_queued_fork",
    appId: "prj_1",
    status: "queued",
    environment: "preview",
    deployKey: "blog__pr-42",
    previewId: approved.previewId!,
    prNumber: 42,
    commitSha: "",
    commitMessage: "x",
    commitAuthor: "x",
    branch: "feat/dark-mode",
    url: "",
    createdAt: new Date().toISOString(),
    creator: "x",
  } as never);

  const pushed = await openOrSyncPreview(
    "prj_1",
    { ...fork, headSha: "deadbeef" },
    { actor: "mallory" },
  );
  assert.deepEqual(pushed.refusal, { kind: "awaiting-approval" });
  const row = await rowOf(h.db, approved.previewId!);
  assert.equal(row.status, "blocked");
  const queued = (await deploymentsOf(h.db, approved.previewId!)).find(
    (d) => d.id === "dpl_queued_fork",
  )!;
  assert.equal(queued.status, "canceled", "the old commit must not build");
  assert.equal(row.tornDownAt, null);
  const due = await previewsDueForReaping(new Date(), 20);
  assert.ok(
    due.retry.some((r) => r.id === approved.previewId),
    "a stack left behind by a withdrawn approval is retried",
  );
});
