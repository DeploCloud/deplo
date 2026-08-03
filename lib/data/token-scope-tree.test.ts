import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  folders as foldersTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { runWithIdentity, type TokenGrant } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";
import { capabilitiesForRole } from "../membership-shared";

import { listApps } from "./apps";
import { listProjects } from "./projects";
import { listFolders } from "./folders";
import { listMembers } from "./members";
import { membershipFor } from "../membership";
import {
  authenticateToken,
  createToken,
  listScopeTree,
  listTokens,
} from "./tokens";

/**
 * The two axes 0062 added: WHICH teams a token reaches, and how far down inside
 * one it can be narrowed — to a whole project, or to a single app.
 *
 * The rule the whole feature turns on is that breadth and depth are different
 * questions. Holding two whole teams restricts nothing inside either of them;
 * naming a project or an app is what strips that team's team-wide capabilities.
 *
 * Fixture: USER_1 is an owner of TEAM_A and TEAM_B. TEAM_A holds `prc_in` with
 * `prj_in` and `prj_sibling`, plus a top-level `prj_top`. TEAM_B holds `prj_b`.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const PRC_IN = "prc_in";

const grant = (over: Partial<TokenGrant> = {}): TokenGrant => ({
  id: "tok_test",
  capabilities: [...ALL_CAPABILITIES],
  scope: null,
  instanceAdmin: false,
  ...over,
});

const as = <T>(
  teamId: string,
  fn: () => Promise<T>,
  over?: Partial<TokenGrant>,
): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId, token: grant(over) }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(
    `truncate table projects, folders, api_tokens restart identity cascade;`,
  );
  await seedIdentity(db);
  // The same person in a SECOND team — the case a one-team token could not express.
  await db
    .insert(membershipsTable)
    .values({
      id: "mem_user_1_b",
      userId: USER_1,
      teamId: TEAM_B,
      role: "owner",
      createdAt: T0,
    });
  await db.insert(membershipCapabilitiesTable).values(
    capabilitiesForRole("owner").map((c) => ({
      membershipId: "mem_user_1_b",
      capability: c,
    })),
  );
  await seedServer(db);
  await db.insert(projectsTable).values({
    id: PRC_IN,
    teamId: TEAM_A,
    name: "In",
    slug: "in",
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, { id: "prj_in", slug: "in-app", projectId: PRC_IN });
  await seedApp(db, { id: "prj_sibling", slug: "sibling", projectId: PRC_IN });
  await seedApp(db, { id: "prj_top", slug: "top-app" });
  await seedApp(db, { id: "prj_b", slug: "b-app", teamId: TEAM_B });
});

const appScope = (appIds: string[], appProjectIds: string[] = []) => ({
  scope: {
    teamIds: [TEAM_A],
    wholeTeamIds: [],
    projectIds: [],
    folderIds: [],
    appIds,
    appProjectIds,
  },
});

test("a token given ONE app sees that app and nothing else in the team", async () => {
  const ids = await as(
    TEAM_A,
    async () => (await listApps()).map((a) => a.id),
    appScope(["prj_in"], [PRC_IN]),
  );
  assert.deepEqual(ids, ["prj_in"], "not its sibling in the same project");
});

test("a token given ONE top-level app reaches it, even with no project anywhere", async () => {
  const ids = await as(
    TEAM_A,
    async () => (await listApps()).map((a) => a.id),
    appScope(["prj_top"]),
  );
  assert.deepEqual(ids, ["prj_top"]);
});

test("an app-scoped token can still see the project its app lives in", async () => {
  await as(
    TEAM_A,
    async () => {
      assert.deepEqual((await listProjects()).map((p) => p.id), [PRC_IN]);
    },
    appScope(["prj_in"], [PRC_IN]),
  );
  // …and a token given a LOOSE app sees no project at all.
  await as(
    TEAM_A,
    async () => assert.deepEqual(await listProjects(), []),
    appScope(["prj_top"]),
  );
});

test("naming a single app is depth: the team-wide capabilities go", async () => {
  await as(
    TEAM_A,
    async () => {
      const m = await membershipFor(USER_1, TEAM_A);
      assert.equal(m!.capabilities.includes("deploy_apps"), true);
      assert.equal(m!.capabilities.includes("manage_members"), false);
      await assert.rejects(() => listMembers(), /limited to specific projects/);
    },
    appScope(["prj_in"], [PRC_IN]),
  );
});

test("holding a WHOLE team is breadth: nothing inside it is restricted", async () => {
  const whole = {
    scope: {
      teamIds: [TEAM_A, TEAM_B],
      wholeTeamIds: [TEAM_A, TEAM_B],
      projectIds: [],
      folderIds: [],
      appIds: [],
      appProjectIds: [],
    },
  };
  await as(
    TEAM_A,
    async () => {
      const ids = (await listApps()).map((a) => a.id);
      assert.deepEqual(ids.sort(), ["prj_in", "prj_sibling", "prj_top"]);
      const m = await membershipFor(USER_1, TEAM_A);
      assert.equal(m!.capabilities.includes("manage_members"), true);
      assert.ok(Array.isArray(await listMembers()));
    },
    whole,
  );
  // The SAME token, acting in the other team, sees that team's apps instead.
  await as(
    TEAM_B,
    async () => assert.deepEqual((await listApps()).map((a) => a.id), ["prj_b"]),
    whole,
  );
});

test("a token narrowed in one team is unrestricted in another it holds wholly", async () => {
  const mixed = {
    scope: {
      teamIds: [TEAM_A, TEAM_B],
      wholeTeamIds: [TEAM_B],
      projectIds: [PRC_IN],
      folderIds: [],
      appIds: [],
      appProjectIds: [],
    },
  };
  await as(
    TEAM_A,
    async () => {
      // Narrowed here: a project, and no team-wide capabilities.
      assert.deepEqual(
        (await listApps()).map((a) => a.id).sort(),
        ["prj_in", "prj_sibling"],
      );
      await assert.rejects(() => listMembers(), /limited to specific projects/);
    },
    mixed,
  );
  await as(
    TEAM_B,
    async () => {
      // Whole team there: everything, including the team-wide reads.
      assert.deepEqual((await listApps()).map((a) => a.id), ["prj_b"]);
      assert.ok(Array.isArray(await listMembers()));
    },
    mixed,
  );
});

/* ------------------------------------------------------------------ */
/* Which team a bearer request resolves to                             */
/* ------------------------------------------------------------------ */

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("a multi-team token resolves to the hinted team, and defaults deterministically", async () => {
  const raw = await asUser1(
    async () =>
      (
        await createToken({
          name: "Both",
          capabilities: ["deploy_apps"] as Capability[],
          teamIds: [TEAM_A, TEAM_B],
        })
      ).raw,
  );

  // No hint: the first team in scope, by team creation order.
  assert.equal((await authenticateToken(raw))?.teamId, TEAM_A);
  // By id, and by slug.
  assert.equal((await authenticateToken(raw, TEAM_B))?.teamId, TEAM_B);
  assert.equal((await authenticateToken(raw, "beta"))?.teamId, TEAM_B);
  // A team the token does NOT hold is ignored rather than honoured.
  assert.equal((await authenticateToken(raw, "team_nope"))?.teamId, TEAM_A);

  const identity = await authenticateToken(raw, TEAM_B);
  assert.deepEqual(identity?.token?.scope?.wholeTeamIds.sort(), [
    TEAM_A,
    TEAM_B,
  ]);
});

test("losing a membership narrows the token to the teams that are left", async () => {
  const raw = await asUser1(
    async () =>
      (
        await createToken({
          name: "Both",
          capabilities: ["deploy_apps"] as Capability[],
          teamIds: [TEAM_A, TEAM_B],
        })
      ).raw,
  );
  await pg.exec(`delete from memberships where id = 'mem_user_1_b';`);
  // The scope still NAMES team B, but the person is no longer in it.
  assert.equal((await authenticateToken(raw, TEAM_B))?.teamId, TEAM_A);
  await pg.exec(`delete from memberships where user_id = '${USER_1}';`);
  assert.equal(await authenticateToken(raw), null);
});

test("a token is listed in every team it can reach, not only where it was made", async () => {
  const id = await asUser1(
    async () =>
      (
        await createToken({
          name: "Both",
          capabilities: ["deploy_apps"] as Capability[],
          teamIds: [TEAM_A, TEAM_B],
        })
      ).token.id,
  );
  const inB = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    listTokens(),
  );
  assert.deepEqual(inB.map((t) => t.id), [id]);
  assert.equal(inB[0]!.homeTeamId, TEAM_A, "still managed from where it was made");
});

test("a foreign team can't be put in a scope", async () => {
  await pg.exec(`delete from memberships where id = 'mem_user_1_b';`);
  await asUser1(async () => {
    await assert.rejects(
      () => createToken({ name: "Reach", teamIds: [TEAM_B] }),
      /not a member of one of those teams/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Folders — the level most apps actually live in                      */
/* ------------------------------------------------------------------ */

/**
 * Filing an app into a folder CLEARS its `project_id`, so before folders were in
 * the tree a project scope reached almost nothing people expected it to, and the
 * picker showed nearly every app as "outside a project".
 *
 * Fixture on top of the one above: TEAM_A gains `fld_root` (filed under
 * `prc_in`) with `fld_child` nested inside it, and `fld_loose` at the team top
 * level. One app in each.
 */
async function seedFolders() {
  await db.insert(foldersTable).values([
    { id: "fld_root", teamId: TEAM_A, name: "Root", projectId: PRC_IN, createdAt: T0, updatedAt: T0 },
    { id: "fld_child", teamId: TEAM_A, name: "Child", parentId: "fld_root", createdAt: T0, updatedAt: T0 },
    { id: "fld_loose", teamId: TEAM_A, name: "Loose", createdAt: T0, updatedAt: T0 },
  ]);
  await seedApp(db, { id: "prj_root", slug: "root-app", folderId: "fld_root" });
  await seedApp(db, { id: "prj_child", slug: "child-app", folderId: "fld_child" });
  await seedApp(db, { id: "prj_loose_f", slug: "loose-app", folderId: "fld_loose" });
}

/** Resolve a real stored scope the way a request does, then run `fn` under it. */
async function underToken<T>(
  input: Parameters<typeof createToken>[0],
  fn: () => Promise<T>,
): Promise<T> {
  const raw = await asUser1(async () => (await createToken(input)).raw);
  const identity = await authenticateToken(raw);
  assert.ok(identity, "the token resolves");
  return runWithIdentity(identity!, fn);
}

test("a folder scope reaches its whole subtree, resolved live", async () => {
  await seedFolders();
  await underToken(
    { name: "Root folder", capabilities: ["deploy_apps"], folderIds: ["fld_root"] },
    async () => {
      assert.deepEqual(
        (await listApps()).map((a) => a.id).sort(),
        ["prj_child", "prj_root"],
        "the nested folder's app comes with the parent",
      );
      // The folders it reaches are listed; the unrelated one is not.
      assert.deepEqual(
        (await listFolders()).map((f) => f.id).sort(),
        ["fld_child", "fld_root"],
      );
    },
  );
});

test("a project scope covers the folders filed under it, not just its own apps", async () => {
  await seedFolders();
  await underToken(
    { name: "Whole project", capabilities: ["deploy_apps"], projectIds: [PRC_IN] },
    async () => {
      assert.deepEqual(
        (await listApps()).map((a) => a.id).sort(),
        ["prj_child", "prj_in", "prj_root", "prj_sibling"],
        "its direct apps AND everything in its folders",
      );
      assert.deepEqual((await listProjects()).map((p) => p.id), [PRC_IN]);
    },
  );
});

test("a top-level folder is reachable, and reaches nothing outside itself", async () => {
  await seedFolders();
  await underToken(
    { name: "Loose folder", capabilities: ["deploy_apps"], folderIds: ["fld_loose"] },
    async () => {
      assert.deepEqual((await listApps()).map((a) => a.id), ["prj_loose_f"]);
      assert.deepEqual((await listFolders()).map((f) => f.id), ["fld_loose"]);
      // It sits in no project, so there is no container to surface.
      assert.deepEqual(await listProjects(), []);
    },
  );
});

test("moving a folder re-scopes the token on the next request, with nothing stored", async () => {
  await seedFolders();
  const raw = await asUser1(
    async () =>
      (
        await createToken({
          name: "Root folder",
          capabilities: ["deploy_apps"],
          folderIds: ["fld_root"],
        })
      ).raw,
  );
  const before = await runWithIdentity((await authenticateToken(raw))!, async () =>
    (await listApps()).map((a) => a.id).sort(),
  );
  assert.deepEqual(before, ["prj_child", "prj_root"]);

  // Un-nest the child folder: it leaves the subtree, and so does its app.
  await pg.exec(`update folders set parent_id = null where id = 'fld_child';`);
  const after = await runWithIdentity((await authenticateToken(raw))!, async () =>
    (await listApps()).map((a) => a.id).sort(),
  );
  assert.deepEqual(after, ["prj_root"]);
});

test("the scope tree nests folders instead of dumping their apps at the top level", async () => {
  await seedFolders();
  const tree = await asUser1(() => listScopeTree());
  const teamA = tree.find((t) => t.id === TEAM_A)!;

  // The regression this level exists for: an app in a folder is NOT loose.
  assert.deepEqual(teamA.looseApps.map((a) => a.id), ["prj_top"]);

  const project = teamA.projects.find((p) => p.id === PRC_IN)!;
  assert.deepEqual(project.apps.map((a) => a.id).sort(), ["prj_in", "prj_sibling"]);
  assert.deepEqual(project.folders.map((f) => f.id), ["fld_root"]);
  assert.deepEqual(project.folders[0]!.apps.map((a) => a.id), ["prj_root"]);
  assert.deepEqual(project.folders[0]!.folders.map((f) => f.id), ["fld_child"]);
  assert.deepEqual(project.folders[0]!.folders[0]!.apps.map((a) => a.id), [
    "prj_child",
  ]);

  assert.deepEqual(teamA.folders.map((f) => f.id), ["fld_loose"]);
});

test("a folder in a team you don't belong to can't be put in a scope", async () => {
  await db.insert(foldersTable).values({
    id: "fld_other",
    teamId: TEAM_B,
    name: "Other",
    createdAt: T0,
    updatedAt: T0,
  });
  await pg.exec(`delete from memberships where id = 'mem_user_1_b';`);
  await asUser1(async () => {
    await assert.rejects(
      () => createToken({ name: "Reach", folderIds: ["fld_other"] }),
      /isn't in a team you belong to/,
    );
  });
});
