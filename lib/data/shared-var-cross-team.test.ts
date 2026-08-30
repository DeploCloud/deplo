import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  sharedEnvVarApps as appJunction,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import { seedServer, seedApp } from "./app-graph-test-helpers";
import {
  deleteSharedVar,
  listSharedVars,
  listSharedVarsForApp,
  loadAutoInjectedVarsForApp,
  loadSharedVarsForApp,
  saveSharedVar,
  setSharedVarAppLink,
} from "./shared-vars";

/**
 * The CROSS-TEAM boundary of a shared variable (ADR-0027): a variable may reach
 * several teams, so every read has to answer "which teams, exactly" and every
 * write has to answer "who may say so".
 */

let db: TestDb;
let pg: PGlite;

const TEAM_C = "team_c";
const APP_A = "prj_a";
const APP_B = "prj_b";
const APP_C = "prj_c";
/** In alpha AND beta, with manage_env in both. */
const BOTH = "u_both";
/** In alpha only. */
const ONLY_A = "u_only_a";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `DO $$ DECLARE r record; BEGIN
       FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
         EXECUTE format('truncate table public.%I restart identity cascade', r.tablename);
       END LOOP; END $$;`,
  );
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
      { id: TEAM_C, slug: "gamma" },
    ],
    users: [
      { id: BOTH, teamId: TEAM_A, role: "owner" },
      { id: `${BOTH}_b`, teamId: TEAM_B, role: "owner" },
      { id: `${BOTH}_c`, teamId: TEAM_C, role: "owner" },
      { id: ONLY_A, teamId: TEAM_A, role: "owner" },
    ],
  });
  // The same person in beta as well - one human, two memberships.
  await db.insert(membershipsTable).values({
    id: "mbr_both_b",
    userId: BOTH,
    teamId: TEAM_B,
    role: "admin",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(membershipCapabilitiesTable).values(
    ["view", "manage_env"].map((c) => ({
      membershipId: "mbr_both_b",
      capability: c as "view",
    })),
  );
  await seedServer(db);
  await seedApp(db, { id: APP_A, teamId: TEAM_A, status: "active" });
  await seedApp(db, { id: APP_B, teamId: TEAM_B, status: "active" });
  await seedApp(db, { id: APP_C, teamId: TEAM_C, status: "active" });
});

const inA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: BOTH, teamId: TEAM_A }, fn);
const inB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: BOTH, teamId: TEAM_B }, fn);
const onlyAInA = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: ONLY_A, teamId: TEAM_A }, fn);

const mkVar = (teamIds: string[], key = "SHARED", value = "v") =>
  inA(() =>
    saveSharedVar({
      key,
      value,
      type: "plain",
      teamIds,
      environmentIds: [],
      projectIds: [],
    }),
  );

const keys = (es: { key: string }[]) => es.map((e) => e.key).sort();

test("a variable scoped to alpha alone is invisible and inert in beta", async () => {
  await mkVar([TEAM_A]);
  assert.deepEqual(await inB(() => listSharedVars()), []);
  assert.deepEqual(await inB(() => listSharedVarsForApp(APP_B)), []);
  assert.deepEqual(await loadSharedVarsForApp(APP_B), []);
  assert.deepEqual(await loadAutoInjectedVarsForApp(APP_B), []);
});

test("two teams: it auto-injects into both, into no third team, and links nothing", async () => {
  await mkVar([TEAM_A, TEAM_B]);
  assert.deepEqual(keys(await loadAutoInjectedVarsForApp(APP_A)), ["SHARED"]);
  assert.deepEqual(keys(await loadAutoInjectedVarsForApp(APP_B)), ["SHARED"]);
  assert.deepEqual(await loadAutoInjectedVarsForApp(APP_C), []);
  // No opt-in was created anywhere - that is what "auto" means.
  assert.deepEqual(await db.select().from(appJunction), []);
});

test("one team only SUGGESTS: the link is still what injects (ADR-0012)", async () => {
  await mkVar([TEAM_A]);
  assert.deepEqual(await loadAutoInjectedVarsForApp(APP_A), []);
  assert.deepEqual(await loadSharedVarsForApp(APP_A), []);
});

test("beta sees a variable alpha shared with it, read-only and stripped", async () => {
  await inA(() =>
    saveSharedVar({
      key: "SHARED",
      value: "v",
      type: "plain",
      teamIds: [TEAM_A, TEAM_B],
      environmentIds: [],
      projectIds: [],
      appIds: [APP_A],
    }),
  );
  const [seen] = await inB(() => listSharedVars());
  assert.ok(seen);
  assert.equal(seen.editable, false);
  assert.equal(seen.ownerTeam?.id, TEAM_A);
  assert.equal(seen.autoInject, true);
  // Alpha's object graph must not be enumerable from beta.
  assert.deepEqual(seen.appIds, []);
  assert.deepEqual(seen.projectIds, []);
  assert.deepEqual(seen.environmentIds, []);
  assert.deepEqual(seen.apps, []);
  // Alpha itself still sees the whole thing.
  const [owned] = await inA(() => listSharedVars());
  assert.equal(owned!.editable, true);
  assert.deepEqual(owned!.appIds, [APP_A]);
});

test("beta may LINK a variable alpha shared with it, but never edit or delete it", async () => {
  const id = await mkVar([TEAM_A, TEAM_B]);
  await assert.rejects(
    () =>
      inB(() =>
        saveSharedVar({
          id,
          key: "SHARED",
          value: "hijacked",
          type: "plain",
          teamIds: [TEAM_B],
          environmentIds: [],
          projectIds: [],
        }),
      ),
    /not found/i,
  );
  await assert.rejects(() => inB(() => deleteSharedVar(id)), /not found/i);
  // Linking is beta's own opt-in, not an edit of alpha's row.
  await inB(() => setSharedVarAppLink(id, APP_B, true));
  assert.deepEqual(keys(await loadSharedVarsForApp(APP_B)), ["SHARED"]);
  // The value alpha wrote is untouched.
  const [v] = await inA(() => listSharedVars());
  assert.equal(v!.value, "v");
});

test("a member of alpha alone cannot tick beta, and nothing is created", async () => {
  await assert.rejects(
    () =>
      onlyAInA(() =>
        saveSharedVar({
          key: "ESCALATE",
          value: "x",
          type: "plain",
          teamIds: [TEAM_A, TEAM_B],
          environmentIds: [],
          projectIds: [],
        }),
      ),
    /not found/i,
  );
  assert.deepEqual(await onlyAInA(() => listSharedVars()), []);
});

test("a token without manage_env of its own cannot tick a second team", async () => {
  // The clamp `membershipFor` applies bails out for a team other than the
  // request's, so the token's OWN capability set has to be read here.
  await assert.rejects(
    () =>
      runWithIdentity(
        {
          userId: BOTH,
          teamId: TEAM_A,
          token: {
            id: "tok_1",
            capabilities: ["view", "deploy_apps"],
            scope: null,
            instanceAdmin: false,
          },
        },
        () =>
          saveSharedVar({
            key: "TOKEN",
            value: "x",
            type: "plain",
            teamIds: [TEAM_A, TEAM_B],
            environmentIds: [],
            projectIds: [],
          }),
      ),
    /permission|not found/i,
  );
});

test("a token holding beta only by project cannot tick beta", async () => {
  await assert.rejects(
    () =>
      runWithIdentity(
        {
          userId: BOTH,
          teamId: TEAM_A,
          token: {
            id: "tok_2",
            capabilities: ["view", "manage_env"],
            scope: {
              teamIds: [TEAM_A, TEAM_B],
              // Breadth, not depth: beta is reachable, but not WHOLLY.
              wholeTeamIds: [TEAM_A],
              projectIds: [],
              folderIds: [],
              appIds: [APP_B],
              appProjectIds: [],
            },
            instanceAdmin: false,
          },
        },
        () =>
          saveSharedVar({
            key: "NARROW",
            value: "x",
            type: "plain",
            teamIds: [TEAM_A, TEAM_B],
            environmentIds: [],
            projectIds: [],
          }),
      ),
    /not found/i,
  );
});

test("deleting the second team does NOT disarm the variable in the first", async () => {
  await mkVar([TEAM_A, TEAM_B]);
  await db.delete(teamsTable).where(eq(teamsTable.id, TEAM_B));
  // `auto_inject` is a column: the reach set losing a row to a cascade must not
  // silently turn an injected variable back into a suggestion.
  assert.deepEqual(keys(await loadAutoInjectedVarsForApp(APP_A)), ["SHARED"]);
});

test("an instance-owned variable reaches its teams and only an admin edits it", async () => {
  const now = "2026-01-01T00:00:00.000Z";
  await pg.exec(`
    insert into shared_env_vars
      (id, team_id, key, value_enc, type, auto_inject, created_at, updated_at)
      values ('svar_ig', null, 'GLOBAL', 'x', 'plain', true, '${now}', '${now}');
    insert into shared_env_var_teams (var_id, team_id)
      values ('svar_ig', '${TEAM_A}');
  `);
  assert.deepEqual(keys(await loadAutoInjectedVarsForApp(APP_A)), ["GLOBAL"]);
  assert.deepEqual(await loadAutoInjectedVarsForApp(APP_B), []);
  const [seen] = await inA(() => listSharedVars());
  // BOTH is seeded `owner`, which is an instance admin.
  assert.equal(seen!.editable, true);
  assert.equal(seen!.ownerTeam, null);
  // A non-admin in the same team sees it, but read-only.
  await db
    .update(usersTable)
    .set({ isInstanceAdmin: false })
    .where(eq(usersTable.id, ONLY_A));
  const [asMember] = await onlyAInA(() => listSharedVars());
  assert.equal(asMember!.editable, false);
});

/* ------------------------------------------------------------------ */
/* What one team's save may do to another team's opt-in (ADR-0027 §2). */
/* ------------------------------------------------------------------ */

test("beta's opt-in does not lock the owner out of its own variable", async () => {
  const id = await mkVar([TEAM_A, TEAM_B]);
  await inB(() => setSharedVarAppLink(id, APP_B, true));
  // The whole-set link replace owns the ACTING team's links and nothing else, so
  // this must not ask for `manage_env` on an app in beta - which alpha never has.
  await inA(() =>
    saveSharedVar({
      id,
      key: "SHARED",
      value: "v2",
      type: "plain",
      teamIds: [TEAM_A, TEAM_B],
      environmentIds: [],
      projectIds: [],
      appIds: [APP_A],
    }),
  );
  const links = await db
    .select()
    .from(appJunction)
    .where(eq(appJunction.varId, id));
  assert.deepEqual(
    links.map((l) => l.appId).sort(),
    [APP_A, APP_B].sort(),
    "beta keeps the app it opted in",
  );
});

test("revoking beta's reach takes beta's per-app links with it", async () => {
  const id = await mkVar([TEAM_A, TEAM_B]);
  await inB(() => setSharedVarAppLink(id, APP_B, true));
  await inA(() =>
    saveSharedVar({
      id,
      key: "SHARED",
      value: "v",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  // Left behind, the row would inject again - at the HIGHEST precedence - the
  // moment the variable is ever re-shared with beta.
  assert.deepEqual(
    await db.select().from(appJunction).where(eq(appJunction.varId, id)),
    [],
  );
});

test("a team the variable already reaches is not re-gated on a save", async () => {
  const id = await mkVar([TEAM_A, TEAM_B]);
  // The author has lost `manage_env` across the whole of beta since. Re-checking
  // the STORED reach is what made a migrated instance-wide variable unsavable.
  await inA(() =>
    runWithIdentity(
      {
        userId: BOTH,
        teamId: TEAM_A,
        token: {
          id: "tok_3",
          capabilities: ["view", "manage_env"],
          scope: {
            teamIds: [TEAM_A, TEAM_B],
            wholeTeamIds: [TEAM_A],
            projectIds: [],
            folderIds: [],
            appIds: [APP_B],
            appProjectIds: [],
          },
          instanceAdmin: false,
        },
      },
      () =>
        saveSharedVar({
          id,
          key: "SHARED",
          value: "v2",
          type: "plain",
          teamIds: [TEAM_A, TEAM_B],
          environmentIds: [],
          projectIds: [],
        }),
    ),
  );
  assert.deepEqual(keys(await loadAutoInjectedVarsForApp(APP_B)), ["SHARED"]);
});

test("a reach row lost to a cascade survives the next ordinary save", async () => {
  const id = await mkVar([TEAM_A, TEAM_B]);
  await db.delete(teamsTable).where(eq(teamsTable.id, TEAM_B));
  await inA(() =>
    saveSharedVar({
      id,
      key: "SHARED",
      value: "v2",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  // ADR-0027 §4 all the way through: the column, not the count.
  assert.deepEqual(keys(await loadAutoInjectedVarsForApp(APP_A)), ["SHARED"]);
});

test("unticking a team the variable still reaches DOES disarm it", async () => {
  const id = await mkVar([TEAM_A, TEAM_B]);
  await inA(() =>
    saveSharedVar({
      id,
      key: "SHARED",
      value: "v",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  assert.deepEqual(await loadAutoInjectedVarsForApp(APP_A), []);
});

test("an edit never ARMS an instance-owned variable that was not injecting", async () => {
  const now = "2026-01-01T00:00:00.000Z";
  await pg.exec(`
    insert into shared_env_vars
      (id, team_id, key, value_enc, type, auto_inject, created_at, updated_at)
      values ('svar_quiet', null, 'QUIET', 'x', 'plain', false, '${now}', '${now}');
    insert into shared_env_var_teams (var_id, team_id)
      values ('svar_quiet', '${TEAM_A}');
  `);
  await inA(() =>
    saveSharedVar({
      id: "svar_quiet",
      key: "QUIET",
      value: "v2",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  assert.deepEqual(await loadAutoInjectedVarsForApp(APP_A), []);
});

test("beta is told who owns the variable, not which other teams run on it", async () => {
  // The author needs gamma too, to be allowed to share with all three.
  await db.insert(membershipsTable).values({
    id: "mbr_both_c",
    userId: BOTH,
    teamId: TEAM_C,
    role: "admin",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(membershipCapabilitiesTable).values(
    ["view", "manage_env"].map((c) => ({
      membershipId: "mbr_both_c",
      capability: c as "view",
    })),
  );
  await mkVar([TEAM_A, TEAM_B, TEAM_C]);
  const [seen] = await inB(() => listSharedVars());
  assert.equal(seen!.ownerTeam?.id, TEAM_A);
  // Gamma exists, and beta has no business knowing that.
  assert.deepEqual(seen!.teamIds, [TEAM_B]);
  assert.deepEqual(
    seen!.teams.map((t) => t.id),
    [TEAM_B],
  );
  assert.equal(seen!.teamWide, true);
});
