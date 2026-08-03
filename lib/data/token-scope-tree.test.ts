import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
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
import { listMembers } from "./members";
import { membershipFor } from "../membership";
import { authenticateToken, createToken, listTokens } from "./tokens";

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
  await pg.exec(`truncate table projects, api_tokens restart identity cascade;`);
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
