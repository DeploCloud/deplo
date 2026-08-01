import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  apps as appsTable,
  appPreviews as appPreviewsTable,
  deployments as deploymentsTable,
} from "../db/schema/control-plane";
import {
  __resetQueueForTest,
  __setRunnerForTest,
} from "../deploy/deploy-queue";
import {
  closePreview,
  openOrSyncPreview,
  previewsDueForReaping,
  previewSettings,
} from "../deploy/preview-lifecycle";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  TRUNCATE_IDENTITY,
  USER_1,
} from "./identity-test-helpers";
import { destroyPreview, redeployPreview } from "./previews";

/**
 * Pull request previews, at the data layer.
 *
 * The invariants worth pinning: the key and host are minted ONCE (the URL is
 * commented on a pull request), the cap REFUSES rather than evicting, a fork
 * builds nothing until someone approves it, a close is retryable, and another
 * team can touch none of it.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The queue is durable in the DB; the in-process dispatcher would try to dial
  // an agent that doesn't exist here. Swap in a fake runner that just SETTLES the
  // row, so these tests measure what a deploy trigger writes rather than a build.
  // It must reach a terminal status: leaving the row `queued` would have the pump
  // pick the same deploy again the instant its slot frees, forever.
  __setRunnerForTest(async (depId: string) => {
    await db
      .update(deploymentsTable)
      .set({ status: "ready" })
      .where(eq(deploymentsTable.id, depId));
  });
});

after(async () => {
  __resetQueueForTest();
  __resetTestDb();
  await pg.close();
});

const PR = {
  number: 42,
  title: "Add dark mode",
  author: "octocat",
  url: "https://github.com/acme/blog/pull/42",
  headBranch: "feat/dark-mode",
  headSha: "abc1234",
  headRepo: "acme/blog",
  headCloneUrl: "https://github.com/acme/blog.git",
  baseBranch: "main",
  isFork: false,
};

/** A github-source app with previews on. */
async function seedPreviewApp(
  id: string,
  opts: { teamId?: string; slug?: string; maxActive?: number; forkPolicy?: string } = {},
): Promise<string> {
  await seedApp(db, {
    id,
    teamId: opts.teamId ?? TEAM_A,
    slug: opts.slug ?? id,
    source: "github",
  });
  await db
    .update(appsTable)
    .set({
      repoProvider: "github",
      repoRepo: "acme/blog",
      repoUrl: "https://github.com/acme/blog",
      repoBranch: "main",
      repoInstallationId: "gi_1",
      previewEnabled: true,
      previewMaxActive: opts.maxActive ?? null,
      previewForkPolicy: opts.forkPolicy ?? null,
    })
    .where(eq(appsTable.id, id));
  return id;
}

const USER_B = "user_b";

beforeEach(async () => {
  await pg.exec(TRUNCATE_IDENTITY + TRUNCATE_PROJECT_GRAPH);
  // A real owner in the OTHER team, so the cross-team cases exercise the data
  // layer's own team filter rather than bouncing off the membership gate first.
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_B, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

test("a preview's deploy key and host are minted once and never move", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const first = await openOrSyncPreview("prj_1", PR, { actor: "octocat" });
  assert.ok(first.previewId);

  const before = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, first.previewId!))
  )[0]!;
  assert.equal(before.deployKey, "blog__pr-42");
  assert.ok(before.host.includes("blog-pr-42"));

  // Three more pushes to the same pull request.
  for (const sha of ["def5678", "aaa1111", "bbb2222"]) {
    await openOrSyncPreview("prj_1", { ...PR, headSha: sha }, { actor: "octocat" });
  }
  const after = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, first.previewId!))
  )[0]!;
  assert.equal(after.deployKey, before.deployKey);
  assert.equal(after.host, before.host, "the link on the pull request must keep working");
  assert.equal(after.headSha, "bbb2222");
});

test("a preview stack key can never be the app's own stack", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "octocat" });
  const row = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.notEqual(row.deployKey, "blog");
  assert.ok(row.deployKey.startsWith("blog__"));
});

test("the cap REFUSES a new preview and leaves the running ones alone", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 2 });
  const a = await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  const b = await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  const c = await openOrSyncPreview("prj_1", { ...PR, number: 3 }, { actor: "o" });

  assert.ok(a.previewId && b.previewId);
  assert.equal(c.previewId, null);
  assert.deepEqual(c.refusal, { kind: "cap", max: 2 });

  // Refuse, never evict: a live URL somebody is testing is not collateral.
  const rows = await db
    .select({ pr: appPreviewsTable.prNumber })
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.appId, "prj_1"));
  assert.deepEqual(
    rows.map((r) => r.pr).sort(),
    [1, 2],
  );
});

test("an EXISTING preview keeps building once the app is at its cap", async () => {
  // Refusing its next push would leave a stale URL live on the pull request.
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 1 });
  const a = await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  const again = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1, headSha: "zzz" },
    { actor: "o" },
  );
  assert.equal(again.previewId, a.previewId);
  assert.equal(again.refusal, undefined);
});

test("a fork's pull request is recorded but builds nothing", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const res = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "mallory/blog" },
    { actor: "mallory" },
  );
  assert.ok(res.previewId, "it must be VISIBLE so a maintainer can approve it");
  assert.deepEqual(res.refusal, { kind: "awaiting-approval" });
  assert.equal(res.deploymentId, null);

  const row = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(row.status, "blocked");
  assert.equal(row.approvedAt, null);
  assert.equal(row.isFork, true);
});

test("fork policy `deny` records nothing at all", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", forkPolicy: "deny" });
  const res = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "mallory/blog" },
    { actor: "mallory" },
  );
  assert.equal(res.previewId, null);
  assert.deepEqual(res.refusal, { kind: "fork-denied" });
  const rows = await db.select().from(appPreviewsTable);
  assert.equal(rows.length, 0);
});

test("fork policy `allow` builds a fork like any other pull request", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", forkPolicy: "allow" });
  const res = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "friend/blog" },
    { actor: "friend" },
  );
  assert.ok(res.previewId);
  assert.equal(res.refusal, undefined);
});

test("previews off means no row and no build", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  await db
    .update(appsTable)
    .set({ previewEnabled: false })
    .where(eq(appsTable.id, "prj_1"));
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  assert.deepEqual(res.refusal, { kind: "previews-off" });
  assert.equal(res.previewId, null);
});

test("a close that could not reach the host stays queued for the reaper", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  // No agent exists in this harness, so the teardown genuinely fails — which is
  // exactly the case the retry predicate is for.
  const gone = await closePreview(res.previewId!, "pull request closed");
  assert.equal(gone, false);

  const row = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(row.state, "closed");
  assert.equal(row.tornDownAt, null, "the only honest record that a stack is still out there");
  assert.ok(row.closedAt);

  const due = await previewsDueForReaping(new Date(), 20);
  assert.deepEqual(
    due.retry.map((r) => r.id),
    [res.previewId],
  );
});

test("closing twice is idempotent and does not move closedAt", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  await closePreview(res.previewId!, "first");
  const first = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  await closePreview(res.previewId!, "second");
  const second = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(second.closedAt, first.closedAt);
});

test("reopening a closed pull request revives the SAME preview and host", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  const host = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!.host;
  await closePreview(res.previewId!, "closed");

  const again = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  assert.equal(again.previewId, res.previewId);
  const row = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(row.state, "open");
  assert.equal(row.host, host);
  assert.equal(row.tornDownAt, null);
});

test("an idle preview is reaped, a fresh one is not", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const fresh = await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  const stale = await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  await db
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

test("the effective settings fall back to the platform defaults", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const s = (await previewSettings("prj_1"))!;
  assert.equal(s.maxActive, 3);
  assert.equal(s.ttlDays, 3);
  assert.equal(s.forkPolicy, "approve");
  assert.equal(s.baseDomain, null);
});

test("another team can neither destroy nor redeploy a preview", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", teamId: TEAM_A });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });

  await runWithIdentity({ userId: USER_B, teamId: TEAM_B }, async () => {
    await assert.rejects(() => destroyPreview(res.previewId!), /not found/i);
    await assert.rejects(() => redeployPreview(res.previewId!), /not found/i);
  });

  // Still open, untouched.
  const row = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(row.state, "open");
});

test("two apps in different teams get different keys and hosts for the same PR number", async () => {
  await seedPreviewApp("prj_1", { slug: "blog-a", teamId: TEAM_A });
  await seedPreviewApp("prj_2", { slug: "blog-b", teamId: TEAM_B });
  const a = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  const b = await openOrSyncPreview("prj_2", PR, { actor: "o" });
  const rows = await db.select().from(appPreviewsTable);
  const ka = rows.find((r) => r.id === a.previewId)!;
  const kb = rows.find((r) => r.id === b.previewId)!;
  assert.notEqual(ka.deployKey, kb.deployKey);
  assert.notEqual(ka.host, kb.host);
});
