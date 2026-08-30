// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

// build.ts reads DEPLO_DATA_DIR at module load - point it somewhere throwaway
// before the module graph pulls it in.
process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-creator-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  activities as activitiesTable,
  apps as appsTable,
  deployments as deploymentsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedPreview,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { __setRunnerForTest, __resetQueueForTest } from "./deploy-queue";
import { startDeployment } from "./build";
import { deployPreviewRow } from "./preview-lifecycle";
import { dispatchPushEvent } from "./git-webhook-dispatch";
import { listDeployments, getDeployment } from "../data/deployments";

/**
 * Who a deployment is credited to: a push credits an account on the git host, a
 * person credits their own. The column is what the UI reads to pick a mark, so a
 * path that forgets it silently draws a stranger as a member of the team.
 */

let db: TestDb;
let pg: PGlite;

const SRV = "srv_a";
const APP = "svc_x";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // Nothing may reach a real host: the queue's runner is the only way out.
  __setRunnerForTest(async () => {});
});

after(async () => {
  __resetQueueForTest();
  // These deploys are never run to completion, so their queued log flush is still
  // in flight - let it land while the test database is still the one it writes to.
  await new Promise((r) => setTimeout(r, 250));
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  __resetQueueForTest();
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db, SRV);
  await seedApp(db, { id: APP, serverId: SRV });
});

async function creditOf(depId: string) {
  const r = (
    await db
      .select({
        creator: deploymentsTable.creator,
        provider: deploymentsTable.creatorProvider,
        userId: deploymentsTable.creatorUserId,
      })
      .from(deploymentsTable)
      .where(eq(deploymentsTable.id, depId))
  )[0];
  assert.ok(r, `deployment ${depId} exists`);
  return r;
}

test("a push credits the pushing account on its host, never a user here", async () => {
  const started = await dispatchPushEvent({
    match: eq(appsTable.id, APP),
    repoFullName: "o/r",
    event: { isTag: false, refName: "main", deleted: false, changedPaths: [] },
    creator: "IdraDev",
    provider: "github",
    commitMessage: "fix: the thing",
    logTag: "test",
  });
  assert.equal(started, 1, "the push deployed the wired app");

  const rows = await db
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable);
  assert.equal(rows.length, 1);
  const credit = await creditOf(rows[0]!.id);
  assert.equal(credit.creator, "IdraDev");
  assert.equal(credit.provider, "github");
  // The whole point: no account here is hunted for a login that belongs to GitHub.
  assert.equal(credit.userId, null);
});

test("a non-GitHub push carries ITS host, not a hardcoded one", async () => {
  await dispatchPushEvent({
    match: eq(appsTable.id, APP),
    repoFullName: "o/r",
    event: { isTag: false, refName: "main", deleted: false, changedPaths: [] },
    creator: "ada",
    provider: "gitea",
    commitMessage: "chore: bump",
    logTag: "test",
  });
  const rows = await db
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable);
  assert.equal((await creditOf(rows[0]!.id)).provider, "gitea");
});

test("a deploy somebody here ran carries no host", async () => {
  const depId = await startDeployment(APP, {
    creator: "Idra",
    commitMessage: "Redeploy of latest commit",
  });
  assert.equal((await creditOf(depId)).provider, null);
});

test("a pull request preview credits the pull request's author", async () => {
  await seedPreview(db, { id: "prv_1", appId: APP, prNumber: 42 });
  const depId = await deployPreviewRow("prv_1", {
    actor: "octocat",
    actorProvider: "github",
  });
  assert.ok(depId);
  const credit = await creditOf(depId);
  assert.equal(credit.creator, "octocat");
  assert.equal(credit.provider, "github");
  assert.equal(credit.userId, null);
});

test("a preview somebody here redeployed credits them, not the host", async () => {
  await seedPreview(db, { id: "prv_2", appId: APP, prNumber: 43 });
  const depId = await deployPreviewRow("prv_2", { actor: "Idra" });
  assert.equal((await creditOf(depId!)).provider, null);
});

/** One push, dispatched exactly as a verified delivery would. */
async function push(creator: string, provider: string): Promise<void> {
  await dispatchPushEvent({
    match: eq(appsTable.id, APP),
    repoFullName: "o/r",
    event: { isTag: false, refName: "main", deleted: false, changedPaths: [] },
    creator,
    provider,
    commitMessage: "feat: land it",
    logTag: "test",
  });
}

const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("the list hands the UI a profile to link, a person's row none", async () => {
  await push("IdraDev", "github");
  await startDeployment(APP, { creator: "Idra", commitMessage: "Redeploy" });

  const rows = await asUser(() => listDeployments({ appId: APP }));
  assert.equal(rows.length, 2);
  const pushed = rows.find((d) => d.creator === "IdraDev")!;
  const person = rows.find((d) => d.creator === "Idra")!;
  assert.equal(pushed.creatorProvider, "github");
  assert.equal(pushed.creatorUrl, "https://github.com/IdraDev");
  assert.equal(person.creatorProvider, null);
  assert.equal(person.creatorUrl, null, "nobody's account is guessed at");
});

test("the deployment page reads the host off the row it is showing", async () => {
  await push("ftita", "github");
  const [row] = await asUser(() => listDeployments({ appId: APP }));
  const dep = await asUser(() => getDeployment(row!.id));
  assert.equal(dep?.creatorProvider, "github");
  assert.equal(dep?.creatorUser, null, "a login resolves to no account here");
});

test("the trail credits the same account the deployment does", async () => {
  await push("IdraDev", "github");
  await startDeployment(APP, { creator: "Idra", commitMessage: "Redeploy" });

  const rows = await db
    .select({
      actor: activitiesTable.actor,
      provider: activitiesTable.actorProvider,
      userId: activitiesTable.actorUserId,
    })
    .from(activitiesTable);
  const pushed = rows.find((r) => r.actor === "IdraDev");
  const person = rows.find((r) => r.actor === "Idra");
  assert.ok(pushed, "the push wrote a trail entry");
  assert.equal(pushed.provider, "github");
  assert.equal(pushed.userId, null);
  assert.ok(person, "so did the person");
  assert.equal(person.provider, null, "a member carries no host");
});
