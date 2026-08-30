import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { deleteEnvironment } from "./environments";
import { seedDatabase } from "./backup-test-helpers";

/**
 * Deleting an environment re-parents its apps rather than deleting them (ADR-0009:
 * an environment is a sub-folder of apps, so removing the sub-folder keeps its
 * contents in the project).
 */

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";
const PRC = "prc_env";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});
after(async () => {
  __resetTestDb();
  await pg.close();
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** Three environments; `defaultId` is the default (null ⇒ the project has none). */
async function seedProjectWith(defaultId: string | null): Promise<void> {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table environments, projects, membership_capabilities, memberships,
    users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await db.insert(projectsTable).values({
    id: PRC,
    teamId: TEAM_A,
    name: "Shop",
    slug: "shop",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(environmentsTable).values(
    ["environ_prod", "environ_stage", "environ_dev"].map((id, position) => ({
      id,
      projectId: PRC,
      name: id,
      slug: id,
      kind: "custom" as const,
      gitBranch: "",
      isDefault: id === defaultId,
      position,
      createdAt: T0,
      updatedAt: T0,
    })),
  );
  await seedApp(db, {
    id: "prj_moved",
    slug: "moved",
    teamId: TEAM_A,
    projectId: PRC,
    environmentId: "environ_dev",
  });
}

const homeOf = async (appId: string) =>
  (await db.select().from(appsTable).where(eq(appsTable.id, appId)))[0]!;

// A database follows the apps rather than the FK's `set null`: landing on the team's
// network would take it away from the very apps that were using it, which is the one
// thing an environment delete must not do.
test("deleting an environment re-parents its databases too", async () => {
  await seedProjectWith("environ_prod");
  const dbId = await seedDatabase(db, { id: "db_moved", teamId: TEAM_A });
  await db
    .update(databasesTable)
    .set({ environmentId: "environ_dev" })
    .where(eq(databasesTable.id, dbId));

  await asUser1(() => deleteEnvironment("environ_dev"));

  const row = (
    await db.select().from(databasesTable).where(eq(databasesTable.id, dbId))
  )[0]!;
  assert.equal(
    row.environmentId,
    "environ_prod",
    "the database lands where its apps did, not at the team level",
  );
});

test("deleting an environment re-parents its apps to the project's default", async () => {
  await seedProjectWith("environ_prod");
  await asUser1(() => deleteEnvironment("environ_dev"));
  const app = await homeOf("prj_moved");
  assert.equal(app.environmentId, "environ_prod");
  assert.equal(app.projectId, PRC, "and it stays in the project");
});

test("with no default anywhere, the apps still land somewhere real", async () => {
  // A project with no default at all shouldn't happen - creation seeds one and this
  // refuses to delete it, so if it ever does, silently clearing `environment_id` is
  // the worst possible answer: the apps vanish from the drill-in with nothing to
  await seedProjectWith(null);
  await asUser1(() => deleteEnvironment("environ_dev"));
  const app = await homeOf("prj_moved");
  assert.equal(
    app.environmentId,
    "environ_prod",
    "the first remaining environment, in display order, never null",
  );
  assert.equal(app.projectId, PRC);
});

test("the default is undeletable, so a project always keeps one", async () => {
  await seedProjectWith("environ_prod");
  await assert.rejects(
    () => asUser1(() => deleteEnvironment("environ_prod")),
    /default environment/i,
  );
  // Emptying the project down to its default still leaves it standing - the
  // default guard is what enforces "at least one" in practice, and the explicit
  // last-one guard below it only ever fires for a project with no default.
  await asUser1(() => deleteEnvironment("environ_dev"));
  await asUser1(() => deleteEnvironment("environ_stage"));
  await assert.rejects(
    () => asUser1(() => deleteEnvironment("environ_prod")),
    /default environment/i,
  );
  const left = await db
    .select()
    .from(environmentsTable)
    .where(eq(environmentsTable.projectId, PRC));
  assert.deepEqual(
    left.map((e) => e.id),
    ["environ_prod"],
  );
});
