import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { runWithIdentity } from "../../auth/request-context";
import { openOrSyncPreview } from "../../deploy/preview-lifecycle/open-sync";
import { seedPreview } from "../app-graph-test-helpers";
import { TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { destroyPreview, listAppPreviews, redeployPreview } from "../previews";
import {
  PR,
  USER_B,
  seedPreviewApp,
  setupPreviews,
} from "./previews-test-helpers";

const h = setupPreviews();

test("another team can neither destroy nor redeploy a preview", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", teamId: TEAM_A });
  const res = await openOrSyncPreview("prj_1", PR, { actor: "o" });

  await runWithIdentity({ userId: USER_B, teamId: TEAM_B }, async () => {
    await assert.rejects(() => destroyPreview(res.previewId!), /not found/i);
    await assert.rejects(() => redeployPreview(res.previewId!), /not found/i);
  });

  const row = (
    await h.db
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, res.previewId!))
  )[0]!;
  assert.equal(row.state, "open");
});

test("the list puts open pull requests first, most recently touched on top", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  await seedPreview(h.db, {
    id: "prv_closed",
    appId: "prj_1",
    prNumber: 1,
    state: "closed",
    lastActivityAt: "2026-09-05T12:00:00.000Z",
  });
  await seedPreview(h.db, {
    id: "prv_stale",
    appId: "prj_1",
    prNumber: 2,
    lastActivityAt: "2026-09-01T12:00:00.000Z",
  });
  await seedPreview(h.db, {
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
