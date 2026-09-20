import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { runWithIdentity } from "../../auth/request-context";
import { deployPreviewRow } from "../../deploy/preview-lifecycle/deploy";
import { openOrSyncPreview } from "../../deploy/preview-lifecycle/open-sync";
import { previewSettings } from "../../deploy/preview-lifecycle/settings";
import { seedServer } from "../app-graph-test-helpers";
import { TEAM_A, USER_1 } from "../identity-test-helpers";
import { loadAppGraph } from "../app-graph-load";
import { setAppPreviewSettings } from "../previews";
import { updateAppSource } from "../apps/source";
import {
  PR,
  rowOf,
  seedPreviewApp,
  setupPreviews,
} from "./previews-test-helpers";

const h = setupPreviews();

test("the effective settings fall back to the platform defaults", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  const s = (await previewSettings("prj_1"))!;
  assert.equal(s.maxActive, 3);
  assert.equal(s.ttlDays, 3);
  assert.equal(s.forkPolicy, "approve");
  assert.equal(s.baseDomain, null);
});

test("repointing previews at another server stops the ones running on the old one", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog", maxActive: 5 });
  await seedServer(h.db, "srv_other");
  await h.db
    .update(serversTable)
    .set({ ip: "10.0.0.2" })
    .where(eq(serversTable.id, "srv_other"));
  const up = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 1 },
    { actor: "o" },
  );
  assert.ok(
    (await rowOf(h.db, up.previewId!)).host.endsWith("-0a000001.deplo.site"),
  );
  const blocked = await openOrSyncPreview(
    "prj_1",
    { ...PR, number: 2, isFork: true, headRepo: "x/blog" },
    { actor: "x" },
  );
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    setAppPreviewSettings("prj_1", { serverId: "srv_other" }),
  );
  assert.equal((await rowOf(h.db, up.previewId!)).status, "evicted");
  assert.equal(
    (await rowOf(h.db, blocked.previewId!)).status,
    "blocked",
    "nothing was running for the fork, so nothing changes",
  );
  assert.equal((await previewSettings("prj_1"))!.serverId, "srv_other");
  const moved = await rowOf(h.db, up.previewId!);
  assert.ok(moved.host.endsWith("-0a000002.deplo.site"), moved.host);
  assert.ok(moved.url.includes(moved.host), moved.url);

  await deployPreviewRow(up.previewId!, { actor: "o" });
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    setAppPreviewSettings("prj_1", { serverId: "srv_other", maxActive: 4 }),
  );
  assert.equal((await rowOf(h.db, up.previewId!)).status, "queued");
});

test("moving the app itself stops its previews, unless they are pinned elsewhere", async () => {
  await seedPreviewApp(h.db, "prj_1", { slug: "blog" });
  await seedServer(h.db, "srv_other");
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
  assert.equal((await rowOf(h.db, up.previewId!)).status, "evicted");
});
