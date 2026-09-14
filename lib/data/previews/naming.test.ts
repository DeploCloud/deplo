import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { runWithIdentity } from "../../auth/request-context";
import { openOrSyncPreview } from "../../deploy/preview-lifecycle/open-sync";
import { LETSENCRYPT_DOMAINS_PER_TEAM_CAP } from "../../deploy/domains";
import { addDomain } from "../domains/crud";
import { TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { PR, seedPreviewApp, setupPreviews } from "./previews-test-helpers";

const h = setupPreviews();

test("a preview's deploy key and host are minted once and never move", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const first = await openOrSyncPreview("prj_1", PR, { actor: "octocat" });
  assert.ok(first.previewId);

  const before = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, first.previewId!))
  )[0]!;
  assert.equal(before.deployKey, "blog__pr-42");
  assert.ok(before.host.includes("blog-pr-42"));

  for (const sha of ["def5678", "aaa1111", "bbb2222"]) {
    await openOrSyncPreview(
      "prj_1",
      { ...PR, headSha: sha },
      { actor: "octocat" },
    );
  }
  const after = (
    await h.db
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
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "octocat" });
  const row = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.notEqual(row.deployKey, "blog");
  assert.ok(row.deployKey.startsWith("blog__"));
});

test("two apps in different teams get different keys and hosts for the same PR number", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog-a", teamId: TEAM_A });
  await seedPreviewApp(h.db, "prj_2", { slug: "blog-b", teamId: TEAM_B });
  const a = await openOrSyncPreview("prj_1", PR, { actor: "o" });
  const b = await openOrSyncPreview("prj_2", PR, { actor: "o" });
  const rows = await h.db.select().from(appPreviewsTable);
  const ka = rows.find((r) => r.id === a.previewId)!;
  const kb = rows.find((r) => r.id === b.previewId)!;
  assert.notEqual(ka.deployKey, kb.deployKey);
  assert.notEqual(ka.host, kb.host);
});

test("a preview's certificate counts against the team's Let's Encrypt quota", async () => {
  // A preview host is never a `domains` row (ADR-0017 §5), so the quota could not see it.
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const now = new Date().toISOString();

  for (let i = 1; i <= LETSENCRYPT_DOMAINS_PER_TEAM_CAP; i++) {
    await h.db.insert(appPreviewsTable).values({
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

  await h.db
    .update(appPreviewsTable)
    .set({ state: "closed" })
    .where(eq(appPreviewsTable.id, "prv_1"));
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    addDomain("prj_1", "one-more.example.com", {
      certProvider: "letsencrypt",
    }),
  );
});
