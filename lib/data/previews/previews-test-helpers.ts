import { before, after, beforeEach } from "node:test";
import { and, eq } from "drizzle-orm";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  appPreviews as appPreviewsTable,
  deployments as deploymentsTable,
} from "../../db/schema/control-plane/deployments";
import {
  __laneSnapshotForTest,
  __resetQueueForTest,
  __setRunnerForTest,
} from "../../deploy/deploy-queue";
import { __disablePreviewCommentsForTest } from "../../deploy/preview-comment";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "../app-graph-test-helpers";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  TRUNCATE_IDENTITY,
  USER_1,
} from "../identity-test-helpers";

export type Harness = { db: TestDb; pg: PGlite };

export const USER_B = "user_b";

export const PR = {
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

export const readyRunner = (db: TestDb) => async (depId: string) => {
  await db
    .update(deploymentsTable)
    .set({ status: "ready" })
    .where(eq(deploymentsTable.id, depId));
};

// A stray queue drain inside the next test's transaction wedges pglite for good.
export async function settleQueue(h: Harness): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const lane = __laneSnapshotForTest(SERVER_1);
    if (lane.running.length === 0 && lane.busyApps.length === 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 30));
  __resetQueueForTest();
  __setRunnerForTest(readyRunner(h.db));
}

export function setupPreviews(): Harness {
  const h = {} as Harness;

  before(async () => {
    const made = await makeTestDb();
    h.db = made.db;
    h.pg = made.pg;
    __setTestDb(made.db);
    __disablePreviewCommentsForTest();
    __setRunnerForTest(readyRunner(made.db));
  });

  after(async () => {
    __resetQueueForTest();
    __resetTestDb();
    await h.pg.close();
  });

  beforeEach(async () => {
    await settleQueue(h);
    await h.pg.exec(TRUNCATE_IDENTITY + TRUNCATE_PROJECT_GRAPH);
    // A real owner in the OTHER team, so the cross-team cases exercise the data layer's own team
    // filter rather than bouncing off the membership gate first.
    await seedIdentity(h.db, {
      users: [
        { id: USER_1, teamId: TEAM_A, role: "owner" },
        { id: USER_B, teamId: TEAM_B, role: "owner" },
      ],
    });
    await seedServer(h.db);
  });

  return h;
}

export async function seedPreviewApp(
  db: TestDb,
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

export async function previewOf(db: TestDb, prNumber: number) {
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

export async function rowOf(db: TestDb, id: string) {
  return (
    await db.select().from(appPreviewsTable).where(eq(appPreviewsTable.id, id))
  )[0]!;
}

export async function deploymentsOf(db: TestDb, previewId: string) {
  return db
    .select()
    .from(deploymentsTable)
    .where(eq(deploymentsTable.previewId, previewId));
}
