import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

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
  deployPreviewRow,
  openOrSyncPreview,
  previewsDueForReaping,
  previewSettings,
  pruneClosedPreviews,
  retryPreviewTeardown,
} from "../deploy/preview-lifecycle";
import {
  seedApp,
  seedPreview,
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
import {
  approvePreview,
  destroyPreview,
  listAppPreviews,
  redeployPreview,
  setAppPreviewSettings,
} from "./previews";
import { updateAppSource } from "./apps";
import { loadAppGraph } from "./app-graph-load";
import { addDomain } from "./domains";
import { LETSENCRYPT_DOMAINS_PER_TEAM_CAP } from "../deploy/domains";

/**
 * Pull request previews, at the data layer.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The queue is durable in the DB; the in-process dispatcher would try to dial an
  // agent that doesn't exist here.
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
  opts: {
    teamId?: string;
    slug?: string;
    maxActive?: number;
    forkPolicy?: string;
  } = {},
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
    await openOrSyncPreview(
      "prj_1",
      { ...PR, headSha: sha },
      { actor: "octocat" },
    );
  }
  const after = (
    await db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, first.previewId!))
  )[0]!;
  assert.equal(after.deployKey, before.deployKey);
  assert.equal(
    after.host,
    before.host,
    "the link on the pull request must keep working",
  );
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

/** One preview row by pull request number. */
async function previewOf(prNumber: number) {
  const rows = await db
    .select()
    .from(appPreviewsTable)
    .where(
      and(
        eq(appPreviewsTable.appId, "prj_1"),
        eq(appPreviewsTable.prNumber, prNumber),
      ),
    );
  return rows[0]!;
}

test("at the cap a new preview EVICTS the least recently active one", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 2 });
  await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  // #1 is now the stalest. Touching #2 is not needed - insertion order already
  // ordered `last_activity_at`, and that is precisely what must decide.
  const c = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 3 },
    { actor: "o" },
  );

  assert.ok(c.previewId, "the new pull request builds");
  assert.equal(c.refusal, undefined);

  // Evicted by ACTIVITY, not by pull request age: the row survives so the same
  // URL can come back, and #2, more recently active, is untouched.
  assert.equal((await previewOf(1)).status, "evicted");
  assert.equal(
    (await previewOf(1)).state,
    "open",
    "the pull request is still open",
  );
  assert.notEqual((await previewOf(2)).status, "evicted");
  assert.notEqual((await previewOf(3)).status, "evicted");
});

test("a push does NOT revive an evicted preview, but Redeploy does", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 1 });
  await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  assert.equal((await previewOf(1)).status, "evicted");
  const evictedKey = (await previewOf(1)).deployKey;

  // A webhook push onto the evicted pull request refreshes its facts and stops.
  // Reviving here would evict #2, whose next push would evict #1 again - two
  // pull requests trading full builds forever.
  const push = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1, headSha: "newsha1" },
    { actor: "o" },
  );
  assert.deepEqual(push.refusal, { kind: "evicted", max: 1 });
  assert.equal(push.deploymentId, null);
  assert.equal(
    (await previewOf(1)).headSha,
    "newsha1",
    "facts still track the PR",
  );
  assert.equal((await previewOf(1)).status, "evicted");
  assert.notEqual((await previewOf(2)).status, "evicted");

  // A person clicking Redeploy is the only thing that brings it back, and it
  // reclaims a slot the same way a new preview does, so the cap still holds.
  const back = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1, headSha: "newsha1" },
    { actor: "someone", manual: true },
  );
  assert.equal(back.refusal, undefined);
  assert.notEqual((await previewOf(1)).status, "evicted");
  assert.equal(
    (await previewOf(1)).deployKey,
    evictedKey,
    "same stack, same URL",
  );
  assert.equal(
    (await previewOf(2)).status,
    "evicted",
    "the cap of 1 still holds",
  );
});

test("a blocked fork evicts NOTHING - a stranger cannot knock a preview over", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 1 });
  await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  assert.equal((await previewOf(1)).status, "queued");

  // An unapproved fork is RECORDED so a maintainer can see and approve it, but it
  // clones nothing and runs nothing.
  const fork = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 2, isFork: true, headRepo: "stranger/blog" },
    { actor: "stranger" },
  );
  assert.deepEqual(fork.refusal, { kind: "awaiting-approval" });
  assert.equal((await previewOf(2)).status, "blocked");
  assert.notEqual(
    (await previewOf(1)).status,
    "evicted",
    "the team's own preview must still be running",
  );

  // Approving it is what claims a slot, and then the cap does apply.
  await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 2, isFork: true, headRepo: "stranger/blog" },
    { actor: "maintainer", approve: true, manual: true },
  );
  assert.notEqual((await previewOf(2)).status, "blocked");
  assert.equal(
    (await previewOf(1)).status,
    "evicted",
    "approving the fork claims a slot like any other build",
  );
});

test("approving a fork through the gated API still respects the cap", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 2 });
  await openOrSyncPreview("prj_1", { ...PR, number: 1 }, { actor: "o" });
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 3, isFork: true, headRepo: "stranger/blog" },
    { actor: "stranger" },
  );

  // approvePreview is a different door into the same build. It must not seat the
  // fork by simply flipping the status: the row has to travel through the one
  // path that claims a slot, or the app ends up over the limit it set.
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, async () => {
    await approvePreview((await previewOf(3)).id);
  });

  const live = (await db.select().from(appPreviewsTable)).filter(
    (p) => p.state === "open" && !["blocked", "evicted"].includes(p.status),
  );
  assert.equal(
    live.length,
    2,
    `cap of 2 exceeded: ${live.map((p) => p.prNumber)}`,
  );
  assert.equal((await previewOf(1)).status, "evicted", "the stalest made room");
  assert.notEqual(
    (await previewOf(3)).status,
    "blocked",
    "the fork is building",
  );
});

test("a blocked fork holds no slot: it has no stack to evict", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 1 });
  // A fork lands blocked under the default `approve` policy - nothing cloned,
  // nothing built. Counting it would let an unapproved stranger's pull request
  // starve the previews of the team's own work.
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
    (await previewOf(9)).status,
    "blocked",
    "the fork is still waiting",
  );
});

test("an EXISTING preview keeps building once the app is at its cap", async () => {
  // Refusing its next push would leave a stale URL live on the pull request.
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 1 });
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
  // No agent exists in this harness, so the teardown genuinely fails, which is
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

test("a preview's certificate counts against the team's Let's Encrypt quota", async () => {
  // A preview host is deliberately never a `domains` row (ADR-0017 §5), which is
  // exactly why the quota could not see it: an app with previews on, a wildcard
  // domain and HTTPS mints one certificate per open pull request, forever, against
  await seedPreviewApp("prj_1", { slug: "blog" });
  const now = new Date().toISOString();

  // Fill the team's allowance entirely with OPEN previews.
  for (let i = 1; i <= LETSENCRYPT_DOMAINS_PER_TEAM_CAP; i++) {
    await db.insert(appPreviewsTable).values({
      id: `prv_${i}`,
      appId: "prj_1",
      prNumber: i,
      headBranch: `pr-${i}`,
      deployKey: `blog__pr-${i}`,
      host: `blog-pr-${i}.example.com`,
      certProvider: "letsencrypt",
      state: "open",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    } as never);
  }

  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
        addDomain("prj_1", "one-more.example.com", {
          certProvider: "letsencrypt",
        }),
      ),
    /limit of \d+ Let's Encrypt domains/,
    "the previews alone should have exhausted the allowance",
  );

  // A closed preview's certificate is not renewed, so it must not hold a slot.
  await db
    .update(appPreviewsTable)
    .set({ state: "closed" })
    .where(eq(appPreviewsTable.id, "prv_1"));
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    addDomain("prj_1", "one-more.example.com", {
      certProvider: "letsencrypt",
    }),
  );
});

/**
 * Approval is per COMMIT, and this is the attack it closes: open something
 * harmless from a fork, get a maintainer to approve the preview, then push the
 * payload.
 */
test("a fork approved at one commit is blocked again by the next push", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const fork = { ...PR, isFork: true, headRepo: "mallory/blog" };

  const first = await openOrSyncPreview("prj_1", fork, { actor: "mallory" });
  assert.deepEqual(first.refusal, { kind: "awaiting-approval" });

  // The maintainer approves what they read: `opts.approve` is the click.
  const approved = await openOrSyncPreview("prj_1", fork, {
    actor: "maintainer",
    approve: true,
    manual: true,
  });
  assert.equal(approved.refusal, undefined, "the reviewed commit builds");

  // …and then the author pushes something else.
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
    await db
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

/* ------------------------------------------------------------------ */
/* A facts-only sync (manual-only apps, title edits)                    */
/* ------------------------------------------------------------------ */

/** The preview's row, by id. */
async function rowOf(id: string) {
  return (
    await db.select().from(appPreviewsTable).where(eq(appPreviewsTable.id, id))
  )[0]!;
}

async function deploymentsOf(previewId: string) {
  return db
    .select()
    .from(deploymentsTable)
    .where(eq(deploymentsTable.previewId, previewId));
}

test("a facts-only sync records the head and builds nothing", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const first = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  const builds = (await deploymentsOf(first.previewId!)).length;

  const synced = await openOrSyncPreview(
    "prj_1",
    { ...PR, headSha: "feedface", title: "Renamed" },
    { actor: "o", build: false },
  );
  assert.equal(synced.previewId, first.previewId);
  assert.equal(synced.deploymentId, null);
  assert.equal(synced.refusal, undefined);
  const row = await rowOf(first.previewId!);
  assert.equal(row.headSha, "feedface");
  assert.equal(row.prTitle, "Renamed");
  assert.equal((await deploymentsOf(first.previewId!)).length, builds);
});

test("a facts-only sync never creates a row and never reopens a closed one", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const none = await openOrSyncPreview("prj_1", PR, {
    actor: "o",
    build: false,
  });
  assert.equal(none.previewId, null);
  assert.equal((await db.select().from(appPreviewsTable)).length, 0);

  const opened = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  await closePreview(opened.previewId!, "closed");
  await openOrSyncPreview(
    "prj_1",
    { ...PR, title: "Edited after close" },
    { actor: "o", build: false },
  );
  const row = await rowOf(opened.previewId!);
  assert.equal(row.state, "closed", "a title edit does not reopen anything");
  assert.equal(row.prTitle, "Edited after close");
});

/**
 * The hole a manual-only app opened: a fork approved at commit A, then a push of
 * commit B that the webhook used to IGNORE, so the row still said "approved at A"
 * while Redeploy built the branch tip - B, which nobody had read.
 */
test("a manual-only fork push withdraws the approval for the new commit", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
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
  const row = await rowOf(approved.previewId!);
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

/* ------------------------------------------------------------------ */
/* A stack that must come down while the pull request stays open        */
/* ------------------------------------------------------------------ */

test("an unreviewed commit takes the fork's running stack down", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const fork = { ...PR, isFork: true, headRepo: "mallory/blog" };
  const approved = await openOrSyncPreview("prj_1", fork, {
    actor: "maintainer",
    approve: true,
    manual: true,
  });
  // Pretend the build landed and a second one is waiting in the queue.
  await db.insert(deploymentsTable).values({
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
  const row = await rowOf(approved.previewId!);
  assert.equal(row.status, "blocked");
  const queued = (await deploymentsOf(approved.previewId!)).find(
    (d) => d.id === "dpl_queued_fork",
  )!;
  assert.equal(queued.status, "canceled", "the old commit must not build");
  // No agent here, so the teardown could not be confirmed: the reaper owns it.
  assert.equal(row.tornDownAt, null);
  const due = await previewsDueForReaping(new Date(), 20);
  assert.ok(
    due.retry.some((r) => r.id === approved.previewId),
    "a stack left behind by a withdrawn approval is retried",
  );
});

test("the reaper retries an evicted stack the host never confirmed gone", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 1 });
  const a = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  assert.equal((await rowOf(a.previewId!)).status, "evicted");
  assert.equal((await rowOf(a.previewId!)).tornDownAt, null);

  let due = await previewsDueForReaping(new Date(), 20);
  assert.deepEqual(
    due.retry.map((r) => r.id),
    [a.previewId],
  );

  // A push onto the evicted preview must not erase what the reaper reads.
  await db
    .update(appPreviewsTable)
    .set({ tornDownAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(appPreviewsTable.id, a.previewId!));
  await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1, headSha: "newsha" },
    { actor: "o" },
  );
  assert.ok((await rowOf(a.previewId!)).tornDownAt, "still confirmed gone");
  due = await previewsDueForReaping(new Date(), 20);
  assert.equal(due.retry.length, 0);
});

test("a fork that never built is not a teardown to retry", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const fork = await openOrSyncPreview(
    "prj_1",
    { ...PR, isFork: true, headRepo: "mallory/blog" },
    { actor: "mallory" },
  );
  assert.equal((await rowOf(fork.previewId!)).status, "blocked");
  const due = await previewsDueForReaping(new Date(), 20);
  assert.equal(due.retry.length, 0);
});

test("a retry picked up by the reaper is skipped once the preview was revived", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 1 });
  const a = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  await openOrSyncPreview("prj_1", { ...PR, number: 2 }, { actor: "o" });
  // Redeploy between the reaper's read and its teardown.
  await deployPreviewRow(a.previewId!, { actor: "someone" });
  assert.equal((await rowOf(a.previewId!)).status, "queued");
  assert.equal(
    await retryPreviewTeardown(a.previewId!),
    false,
    "must not tear down the stack being built",
  );
});

test("a deploy refused before it was queued leaves the row in error, not queued", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const a = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  // Mid-migration apps refuse every deploy (assertNotMigrating).
  await db
    .update(appsTable)
    .set({ migrationRunId: "mig_1" })
    .where(eq(appsTable.id, "prj_1"));
  await assert.rejects(
    () => deployPreviewRow(a.previewId!, { actor: "o" }),
    /migration/,
  );
  assert.equal((await rowOf(a.previewId!)).status, "error");
});

/* ------------------------------------------------------------------ */
/* Rows are pruned, and the list is ordered                             */
/* ------------------------------------------------------------------ */

test("a closed pull request keeps its row for a week, then only if its stack is unconfirmed", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  const now = new Date("2026-09-05T12:00:00.000Z");
  const old = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString();
  const recent = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString();
  const seed = (
    id: string,
    prNumber: number,
    closedAt: string,
    torn: boolean,
  ) =>
    seedPreview(db, {
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
  await seedPreview(db, { id: "prv_open", appId: "prj_1", prNumber: 4 });

  assert.equal(await pruneClosedPreviews(now, 50), 1);
  const left = (await db.select().from(appPreviewsTable)).map((r) => r.id);
  assert.deepEqual(left.sort(), ["prv_old_stuck", "prv_open", "prv_recent"]);
});

test("the list puts open pull requests first, most recently touched on top", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  await seedPreview(db, {
    id: "prv_closed",
    appId: "prj_1",
    prNumber: 1,
    state: "closed",
    lastActivityAt: "2026-09-05T12:00:00.000Z",
  });
  await seedPreview(db, {
    id: "prv_stale",
    appId: "prj_1",
    prNumber: 2,
    lastActivityAt: "2026-09-01T12:00:00.000Z",
  });
  await seedPreview(db, {
    id: "prv_fresh",
    appId: "prj_1",
    prNumber: 3,
    lastActivityAt: "2026-09-03T12:00:00.000Z",
  });
  const view = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    listAppPreviews("prj_1"),
  );
  assert.deepEqual(
    view.previews.map((p) => p.id),
    ["prv_fresh", "prv_stale", "prv_closed"],
  );
});

/* ------------------------------------------------------------------ */
/* Moving previews to another machine                                   */
/* ------------------------------------------------------------------ */

test("repointing previews at another server stops the ones running on the old one", async () => {
  await seedPreviewApp("prj_1", { slug: "blog", maxActive: 5 });
  await seedServer(db, "srv_other");
  const up = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  const blocked = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 2, isFork: true, headRepo: "x/blog" },
    { actor: "x" },
  );
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    setAppPreviewSettings("prj_1", { serverId: "srv_other" }),
  );
  assert.equal((await rowOf(up.previewId!)).status, "evicted");
  assert.equal(
    (await rowOf(blocked.previewId!)).status,
    "blocked",
    "nothing was running for the fork, so nothing changes",
  );
  assert.equal((await previewSettings("prj_1"))!.serverId, "srv_other");

  // Saving the same server again is not a change, and stops nothing.
  await deployPreviewRow(up.previewId!, { actor: "o" });
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    setAppPreviewSettings("prj_1", { serverId: "srv_other", maxActive: 4 }),
  );
  assert.equal((await rowOf(up.previewId!)).status, "queued");
});

test("moving the app itself stops its previews, unless they are pinned elsewhere", async () => {
  await seedPreviewApp("prj_1", { slug: "blog" });
  await seedServer(db, "srv_other");
  const up = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  const app = (await loadAppGraph("prj_1"))!;
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    updateAppSource("prj_1", {
      source: "github",
      repo: app.repo,
      dockerImage: null,
      serverId: "srv_other",
    }),
  );
  assert.equal((await rowOf(up.previewId!)).status, "evicted");
});
