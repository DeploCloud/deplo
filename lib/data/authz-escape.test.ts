import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

// Set BEFORE the modules load: with a configured public URL the deploy hook
// never reaches for request headers, which is what makes it drivable from here.
process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { eq } from "drizzle-orm";

import {
  projects as projectsTable,
  sharedEnvVars as sharedEnvVarsTable,
} from "../db/schema/control-plane";
import { decryptSecret } from "../crypto";
import { runWithIdentity, type TokenGrant } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  USER_1,
} from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedRun,
  seedS3,
  seedDestination,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";

import {
  deleteSharedVar,
  listSharedVars,
  listSharedVarsForApp,
  saveSharedVar,
  setSharedVarAppLink,
} from "./shared-vars";
import {
  createBackup,
  deleteAllBackupArtifacts,
  deleteBackup,
  restoreBackup,
  runBackup,
  downloadBackupArtifact,
  toggleBackup,
  updateBackup,
} from "./backups";
import { revealRecoveryKey } from "./destinations";
import { listApps } from "./apps";
import { createFolder, listFolders, moveAppToFolder } from "./folders";
import { moveAppToProject } from "./projects";
import { createRole, listRoles, resetRole, updateRole } from "./roles";
import { createToken } from "./tokens";
import { updateMember } from "./members";
import {
  deployHookUrlMasked,
  revealDeployHook,
  verifyDeployHookToken,
} from "./deploy-hook";

/**
 * ESCAPING YOUR OWN BOUNDARY - the three ways Deplo hands out less than
 * everything, and what happens when a caller tries to reach past the line. a
 * DEPLOY HOOK, which is one app's URL secret plus a bearer token.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const PRC_IN = "prc_in";
const PRC_OUT = "prc_out";
const APP_IN = "prj_in";
const APP_OUT = "prj_out";
const DB = "db_main";
const DEST = "s3_main";

/** Holds every capability, but reaches only `prc_in`. */
const grant = (over: Partial<TokenGrant> = {}): TokenGrant => ({
  id: "tok_test",
  capabilities: [...ALL_CAPABILITIES],
  scope: {
    teamIds: [TEAM_A],
    wholeTeamIds: [],
    projectIds: [PRC_IN],
    folderIds: [],
    appIds: [],
    appProjectIds: [],
  },
  instanceAdmin: false,
  ...over,
});

/** As the project-scoped token. */
const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A, token: grant() }, fn);

/** The same owner over a cookie session - the control for every refusal below. */
const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

/** Assert a call is refused, and report what it actually did when it isn't. */
async function refused(
  fn: () => Promise<unknown>,
  what: string,
): Promise<string> {
  try {
    await fn();
    assert.fail(`${what} - the call went through`);
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(
      msg,
      /not found|permission|can't access|only|Unauthorized/i,
      `${what} - refused, but for the wrong reason: ${msg}`,
    );
    return msg;
  }
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_BACKUPS);
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(`truncate table
    projects, activities, team_role_capabilities, team_roles
    restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // A "role administrator": may edit roles, and nothing else.
      {
        id: "u_roles",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_roles"],
      },
    ],
  });
  await seedServer(db);
  await db.insert(projectsTable).values([
    {
      id: PRC_IN,
      teamId: TEAM_A,
      name: "In",
      slug: "in",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: PRC_OUT,
      teamId: TEAM_A,
      name: "Out",
      slug: "out",
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(db, { id: APP_IN, slug: "in-app", projectId: PRC_IN });
  await seedApp(db, { id: APP_OUT, slug: "out-app", projectId: PRC_OUT });
  await seedDatabase(db, { id: DB, name: "main" });
  await seedS3(db, { id: DEST });
});

/* ------------------------------------------------------------------ */
/* 1. A narrowed API token vs. the team's shared variables             */
/* ------------------------------------------------------------------ */

/** A team-wide shared secret, authored by the owner over a session. */
async function teamWideSecret(): Promise<string> {
  return asUser(async () => {
    await saveSharedVar({
      key: "STRIPE_KEY",
      value: "sk_live_hunter2",
      type: "secret",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    });
    const found = (await listSharedVars()).find((v) => v.key === "STRIPE_KEY");
    assert.ok(found, "the fixture var exists");
    return found.id;
  });
}

test("a project-scoped token can't read the team's shared secrets back", async () => {
  await teamWideSecret();

  // The control: the same library, the same user, over a session - masked even
  // there, because a secret has no read-back path for anyone.
  const mine = await asUser(() => listSharedVars());
  assert.ok(
    !JSON.stringify(mine).includes("sk_live_hunter2"),
    "not even a session carries the plaintext",
  );

  await refused(
    () => scoped(() => listSharedVars()),
    "a token limited to one project read the team-wide shared library",
  );
});

test("nor author one - a team-wide var reaches every app in the team", async () => {
  const id = await teamWideSecret();

  // Creating: the var would be injected into apps in `prc_out` too, at the
  // highest deploy precedence.
  await refused(
    () =>
      scoped(() =>
        saveSharedVar({
          key: "INJECTED",
          value: "x",
          type: "plain",
          teamIds: [TEAM_A],
          environmentIds: [],
          projectIds: [],
        }),
      ),
    "a narrowed token created a team-wide shared variable",
  );

  // Editing an existing one is the same escape with an extra step: rewriting a
  // value every out-of-scope app already consumes.
  await refused(
    () =>
      scoped(() =>
        saveSharedVar({
          id,
          key: "STRIPE_KEY",
          value: "sk_live_attacker",
          type: "secret",
          teamIds: [TEAM_A],
          environmentIds: [],
          projectIds: [],
        }),
      ),
    "a narrowed token rewrote a team-wide shared variable",
  );

  const [row] = await db
    .select({ valueEnc: sharedEnvVarsTable.valueEnc })
    .from(sharedEnvVarsTable)
    .where(eq(sharedEnvVarsTable.id, id));
  assert.equal(
    decryptSecret(row!.valueEnc),
    "sk_live_hunter2",
    "and the stored value is untouched",
  );
});

test("nor enumerate them from an app it does reach", async () => {
  await teamWideSecret();
  // A plain one too: only `secret` rows are masked, so a team-wide plain var is
  // the value itself, not just its name.
  await asUser(() =>
    saveSharedVar({
      key: "SENTRY_DSN",
      value: "https://team-wide-dsn",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );

  // The control: over a session the same app's page shows the whole team set,
  // which is ADR-0012's "scopes only suggest" and must not regress.
  const mine = await asUser(() => listSharedVarsForApp(APP_IN));
  assert.deepEqual(
    mine.map((v) => v.key).sort(),
    ["SENTRY_DSN", "STRIPE_KEY"],
    "a session still sees the whole team's shared vars from any app",
  );

  // The scoped token holds `manage_env` on APP_IN - it survives the project
  // clamp on purpose, so this page is INSIDE its scope and cannot refuse. What
  // it must not do is hand over the team's catalogue while it's there.
  const theirs = await scoped(() => listSharedVarsForApp(APP_IN));
  assert.deepEqual(
    theirs.map((v) => v.key),
    [],
    "a narrowed token read the team's shared variables from an app it reaches",
  );
  assert.ok(
    !JSON.stringify(theirs).includes("team-wide-dsn"),
    "and no plaintext of a team-wide var came with it",
  );
});

test("nor link one into an app it controls", async () => {
  const id = await teamWideSecret();

  // Linking injects the value at the highest deploy precedence into an app the
  // token holds a console and logs on, so it is a read-back by other means,
  // which is why the whole shared library is `requireTeamWide`.
  const refusal = await refused(
    () => scoped(() => setSharedVarAppLink(id, APP_IN, true)),
    "a narrowed token linked a team-wide secret into its own app",
  );
  const unknown = await refused(
    () => scoped(() => setSharedVarAppLink("env_nope", APP_IN, true)),
    "an unknown variable id",
  );
  assert.equal(
    refusal,
    unknown,
    "the refusal must be the unknown-id message: a scope is no existence oracle",
  );

  // The control: a var whose own scope names the token's project IS theirs to
  // link. The rule is "does this variable pertain to this app", not "is the
  // caller narrowed".
  const ownId = await asUser(async () => {
    await saveSharedVar({
      key: "PROJECT_KEY",
      value: "p",
      type: "plain",
      teamIds: [],
      environmentIds: [],
      projectIds: [PRC_IN],
    });
    return (await listSharedVars()).find((v) => v.key === "PROJECT_KEY")!.id;
  });
  await scoped(() => setSharedVarAppLink(ownId, APP_IN, true));
  const linked = await scoped(() => listSharedVarsForApp(APP_IN));
  assert.deepEqual(
    linked.map((v) => ({ key: v.key, linked: v.linked })),
    [{ key: "PROJECT_KEY", linked: true }],
  );
});

test("nor delete one", async () => {
  const id = await teamWideSecret();
  await refused(
    () => scoped(() => deleteSharedVar(id)),
    "a narrowed token deleted a team-wide shared variable",
  );
  assert.equal(
    (await asUser(() => listSharedVars())).length,
    1,
    "the variable survives",
  );
});

/* ------------------------------------------------------------------ */
/* 1b. A narrowed API token vs. the placement of apps                  */
/* ------------------------------------------------------------------ */

/**
 * A move is the one verb that changes what a scope CONTAINS, from inside it,
 * and the reason it is not an escape today is upstream of every gate:
 * `move_apps` is deliberately absent from `PROJECT_SCOPED_CAPABILITIES`
 * ("a token editing its own boundary"), so the clamp strips it and a narrowed
 * token cannot move anything at all. This pins that, because it is the whole
 * defence: put `move_apps` back in that list and every mover below opens.
 */
test("a narrowed token holds no move at all, in or out of its scope", async () => {
  await asUser(() => createFolder("Mine"));
  const fld = (await asUser(() => listFolders()))[0]!.id;

  for (const [what, call] of [
    [
      "an app it doesn't reach, into a folder",
      () => moveAppToFolder(APP_OUT, fld),
    ],
    ["its own app, into a folder", () => moveAppToFolder(APP_IN, fld)],
    [
      "its own app, into an out-of-scope project",
      () => moveAppToProject(APP_IN, PRC_OUT),
    ],
  ] as const) {
    await refused(() => scoped(call), `a narrowed token moved ${what}`);
  }

  assert.equal(
    (await asUser(() => listApps())).find((a) => a.id === APP_IN)?.projectId,
    PRC_IN,
    "nothing moved",
  );
});

/* ------------------------------------------------------------------ */
/* 2. A narrowed API token vs. the team's database backups             */
/* ------------------------------------------------------------------ */

/**
 * A database backup schedule + one successful run. A database belongs to no
 * Project, so NOTHING here is reachable by a project-scoped token, but
 * `manage_backups` / `restore_backups` both survive the project clamp (they mean
 * something on an app), so each entry point has to say so itself.
 */
async function dbBackup(): Promise<{ backupId: string; runId: string }> {
  const backupId = await seedBackup(db, {
    id: "bkp_db",
    destinationId: DEST,
    databaseId: DB,
    targetKind: "database",
  });
  const runId = await seedRun(db, {
    id: "run_db",
    backupId,
    destinationId: DEST,
    databaseId: DB,
    targetKind: "database",
    status: "success",
  });
  return { backupId, runId };
}

test("a project-scoped token can't restore a database it can't even see", async () => {
  const { runId } = await dbBackup();
  // The gravest one: a restore stops the database, wipes its volume and untars
  // an old dump over it. A token scoped to one project must not be able to fire
  // that at a database outside its scope.
  await refused(
    () => scoped(() => restoreBackup(runId)),
    "a narrowed token restored a database backup",
  );
});

test("nor download its artifact - a dump is every byte the database holds", async () => {
  const { runId } = await dbBackup();
  // Downloading is the quiet sibling of restoring: it does not touch the live
  // database, so it looks harmless, and it hands over the entire contents. It is
  // gated on `restore_backups` for exactly that reason, and a token that cannot
  // see the database must not reach it either.
  await refused(
    () => scoped(() => downloadBackupArtifact(runId)),
    "a narrowed token downloaded a database backup",
  );
});

test("nor take the recovery key that decrypts every artifact at a destination", async () => {
  const dest = await seedDestination(db, {
    id: "dst_srv_escape",
    kind: "server",
    serverId: SERVER_1,
  });
  // The key is worth more than any single artifact: with it, every backup ever
  // written to that destination is readable, forever, off a disk. A destination
  // belongs to the team and to no Project, so a narrowed token has no path to it.
  await refused(
    () => scoped(() => revealRecoveryKey(dest)),
    "a narrowed token took a destination's recovery key",
  );
});

test("nor run, pause, edit or delete its schedule", async () => {
  const { backupId } = await dbBackup();

  await refused(() => scoped(() => runBackup(backupId)), "runBackup");
  await refused(
    () => scoped(() => toggleBackup(backupId, false)),
    "toggleBackup",
  );
  await refused(
    () =>
      scoped(() =>
        updateBackup(backupId, {
          name: "hijacked",
          destinationId: DEST,
          schedule: "0 4 * * *",
          retentionCount: 1,
        }),
      ),
    "updateBackup",
  );
  await refused(() => scoped(() => deleteBackup(backupId)), "deleteBackup");
});

test("nor schedule a new dump of one, nor wipe its artifacts", async () => {
  await dbBackup();

  await refused(
    () =>
      scoped(() =>
        createBackup({
          name: "exfil",
          targetKind: "database",
          databaseId: DB,
          destinationId: DEST,
          schedule: "0 3 * * *",
          retentionCount: 7,
        }),
      ),
    "a narrowed token scheduled a dump of an out-of-scope database",
  );

  await refused(
    () =>
      scoped(() =>
        deleteAllBackupArtifacts({ kind: "database", targetId: DB }),
      ),
    "a narrowed token wiped an out-of-scope database's artifacts",
  );
});

test("and the refusal is scope, not permission - the session still does all of it", async () => {
  const { backupId } = await dbBackup();
  // The control that keeps the fix honest: the same calls, the same user, over a
  // cookie session. If these break, the guard is over-refusing.
  await asUser(() => toggleBackup(backupId, false));
  await asUser(() =>
    updateBackup(backupId, {
      name: "nightly",
      destinationId: DEST,
      schedule: "0 4 * * *",
      retentionCount: 3,
    }),
  );
  await asUser(() =>
    createBackup({
      name: "second",
      targetKind: "database",
      databaseId: DB,
      destinationId: DEST,
      schedule: "0 5 * * *",
      retentionCount: 7,
    }),
  );
  await asUser(() => deleteBackup(backupId));
});

test("an APP backup inside the scope is still reachable - the guard is about databases", async () => {
  const created = await scoped(() =>
    createBackup({
      name: "in-scope",
      targetKind: "app",
      databaseId: null,
      appId: APP_IN,
      destinationId: DEST,
      schedule: "0 3 * * *",
      retentionCount: 7,
    }),
  );
  assert.equal(created.targetKind, "app");

  // ...and the app in the OTHER project is still refused, by the app gate.
  await refused(
    () =>
      scoped(() =>
        createBackup({
          name: "out-of-scope",
          targetKind: "app",
          databaseId: null,
          appId: APP_OUT,
          destinationId: DEST,
          schedule: "0 3 * * *",
          retentionCount: 7,
        }),
      ),
    "a narrowed token scheduled a backup of an out-of-scope app",
  );
});

/* ------------------------------------------------------------------ */
/* 3. Roles - every door into a role carries the same bound            */
/* ------------------------------------------------------------------ */

/** The team's built-in Member role, as stored. */
async function memberRole(): Promise<{
  id: string;
  capabilities: Capability[];
}> {
  const roles = await asUser(() => listRoles());
  const r = roles.find((x) => x.builtinKey === "member");
  assert.ok(r, "the Member default is seeded");
  return { id: r.id, capabilities: r.capabilities };
}

test("resetting a default role can't hand out more than the actor holds", async () => {
  const member = await memberRole();
  // The owner narrows Member down to a read-only role that may still edit roles.
  await asUser(() =>
    updateRole({
      id: member.id,
      name: "Member",
      capabilities: ["view", "manage_roles"],
    }),
  );

  // "Reset to default" rewrites the capabilities of everyone holding the role,
  // so it is authoring a role by another name, and it answers to the same bound
  // as `updateRole`, or it is the way around it.
  await refused(
    () => as("u_roles", () => resetRole(member.id)),
    "a manage_roles holder reset a role back above their own permissions",
  );

  const after = await asUser(() => listRoles());
  assert.deepEqual(
    after.find((r) => r.id === member.id)?.capabilities,
    ["view", "manage_roles"],
    "and the narrowed role is still narrowed",
  );
});

test("so a member holding that role can't reset their way back to the preset", async () => {
  const member = await memberRole();
  await asUser(() =>
    updateRole({
      id: member.id,
      name: "Member",
      capabilities: ["view", "manage_roles"],
    }),
  );
  // Put the role administrator ON the narrowed role: now a reset would rewrite
  // their OWN membership_capabilities row.
  await asUser(() => updateMember({ userId: "u_roles", roleId: member.id }));

  await refused(
    () => as("u_roles", () => resetRole(member.id)),
    "a member reset the role they hold and widened themselves",
  );

  const { membershipFor } = await import("../membership");
  assert.deepEqual(
    (await membershipFor("u_roles", TEAM_A))?.capabilities,
    ["view", "manage_roles"],
    "their effective capabilities are unchanged",
  );
});

test("an owner still resets it, and a custom role still has no default", async () => {
  const member = await memberRole();
  await asUser(() =>
    updateRole({
      id: member.id,
      name: "Member",
      capabilities: ["view", "manage_roles"],
    }),
  );

  await asUser(() => resetRole(member.id));
  const after = await asUser(() => listRoles());
  assert.deepEqual(
    after.find((r) => r.id === member.id)?.capabilities,
    member.capabilities,
    "the shipped preset is back",
  );

  const custom = await asUser(() =>
    createRole({ name: "Bespoke", capabilities: ["view"] }),
  );
  await refused(
    () => asUser(() => resetRole(custom.id)),
    "a custom role was reset to a default it never had",
  );
});

/* ------------------------------------------------------------------ */
/* 4. Deploy hooks - one URL secret, one app                           */
/* ------------------------------------------------------------------ */

test("one app's hook secret is useless against another app", async () => {
  const urlIn = await asUser(() => revealDeployHook(APP_IN));
  const urlOut = await asUser(() => revealDeployHook(APP_OUT));
  const secretIn = urlIn.slice(urlIn.lastIndexOf("/") + 1);
  const secretOut = urlOut.slice(urlOut.lastIndexOf("/") + 1);
  assert.notEqual(secretIn, secretOut, "each app mints its own secret");

  assert.deepEqual(await verifyDeployHookToken(APP_IN, secretIn), {
    ok: true,
    teamId: TEAM_A,
  });
  // The secret is per app, so holding one app's URL - legitimately, as its
  // deployer - says nothing about any other app's.
  assert.deepEqual(await verifyDeployHookToken(APP_IN, secretOut), {
    ok: false,
    reason: "bad-token",
  });
  // ...and an app that has never had a hook opened has no valid secret at all.
  await seedApp(db, { id: "prj_fresh", slug: "fresh" });
  assert.deepEqual(await verifyDeployHookToken("prj_fresh", secretIn), {
    ok: false,
    reason: "bad-token",
  });
});

test("the masked hook URL is a mask, not a prefix of the secret", async () => {
  const url = await asUser(() => revealDeployHook(APP_IN));
  const secret = url.slice(url.lastIndexOf("/") + 1);
  const masked = await deployHookUrlMasked(APP_IN);

  assert.ok(
    masked.startsWith(`https://deplo.test/api/apps/${APP_IN}/deploy-hook/`),
  );
  assert.ok(!masked.includes(secret), "the whole secret is absent");
  // Not even the first characters: a settings page renders this for anyone who
  // can read the app, including members without `configure_apps`.
  assert.ok(!masked.includes(secret.slice(0, 4)), "nor its leading characters");
});

/* ------------------------------------------------------------------ */
/* 5. Rank is not authority - the bound reads capabilities, never role  */
/* ------------------------------------------------------------------ */

/**
 * `memberships.role` is a RANK, and it is the one part of a membership the API
 * token clamp does NOT narrow: a token gets its creator's `role` verbatim and
 * only their capabilities intersected. So every place that used to read
 * `actor.role === "owner"` as "may hand out anything" was a door out of the
 * token's own capability set - the owner behind an ordinary token could mint an
 * all-powerful successor, re-scope the role every member holds, or promote a
 * member, from a token that was granted one administrative permission.
 *
 * The bound is the actor's CAPABILITIES everywhere now. A real owner holds all
 * of them, so nothing legitimate changed; what changed is that a token stops at
 * what it was given.
 */

/** An owner's token holding exactly one administrative capability. */
const adminToken = (cap: Capability): TokenGrant => ({
  id: "tok_admin",
  capabilities: ["view", cap],
  scope: null,
  instanceAdmin: false,
});

const asToken = <T>(cap: Capability, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity(
    { userId: USER_1, teamId: TEAM_A, token: adminToken(cap) },
    fn,
  );

test("an owner's manage_tokens token can't mint a successor above itself", async () => {
  await refused(
    () =>
      asToken("manage_tokens", () =>
        createToken({ name: "Successor", capabilities: [...ALL_CAPABILITIES] }),
      ),
    "a one-permission token minted an all-powerful one",
  );
  // It still mints what it actually holds - the bound is a ceiling, not a ban.
  const ok = await asToken("manage_tokens", () =>
    createToken({ name: "Sibling", capabilities: ["view", "manage_tokens"] }),
  );
  assert.deepEqual(ok.token.capabilities, ["view", "manage_tokens"]);
});

test("an owner's manage_roles token can't widen the role every member holds", async () => {
  const member = await memberRole();
  await refused(
    () =>
      asToken("manage_roles", () =>
        updateRole({
          id: member.id,
          name: "Member",
          capabilities: [...ALL_CAPABILITIES],
        }),
      ),
    "a one-permission token re-scoped a role to full access",
  );
  await refused(
    () =>
      asToken("manage_roles", () =>
        createRole({ name: "Godmode", capabilities: [...ALL_CAPABILITIES] }),
      ),
    "a one-permission token authored an all-powerful role",
  );
  assert.deepEqual(
    (await asUser(() => listRoles())).find((r) => r.id === member.id)
      ?.capabilities,
    member.capabilities,
    "the Member role is untouched",
  );
});

test("an owner's manage_members token can't promote anyone past itself", async () => {
  // The legacy rank + capabilities path CLAMPS rather than refusing (that is its
  // documented contract, and what the registration links rely on), so the proof
  // is the set that lands, not an error.
  await asToken("manage_members", () =>
    updateMember({
      userId: "u_roles",
      role: "member",
      capabilities: [...ALL_CAPABILITIES],
    }),
  );
  const { membershipFor } = await import("../membership");
  assert.deepEqual(
    (await membershipFor("u_roles", TEAM_A))?.capabilities,
    ["view", "manage_members"],
    "the member got the token's own set, never the owner's",
  );

  // And the role path, which refuses outright, agrees.
  const member = await memberRole();
  await refused(
    () =>
      asToken("manage_members", () =>
        updateMember({ userId: "u_roles", roleId: member.id }),
      ),
    "a one-permission token assigned a role richer than itself",
  );
});

test("an owner-RANK member with a narrowed set can't author their way out", async () => {
  // The legacy `role` + `capabilities` path (the public API, registration links) can
  // mint an owner-rank membership that holds only some capabilities.
  await asUser(() =>
    updateMember({
      userId: "u_roles",
      role: "owner",
      capabilities: ["view", "manage_roles", "manage_members"],
    }),
  );
  await refused(
    () =>
      as("u_roles", () =>
        createRole({ name: "Godmode", capabilities: ["view", "delete_team"] }),
      ),
    "an owner-rank member authored a role above their own permissions",
  );
  // The legacy path clamps instead of refusing, so what proves it is the set
  // that lands: their own, not the everything they asked for.
  await as("u_roles", () =>
    updateMember({
      userId: "u_roles",
      role: "owner",
      capabilities: [...ALL_CAPABILITIES],
    }),
  );
  const { membershipFor } = await import("../membership");
  assert.deepEqual(
    (await membershipFor("u_roles", TEAM_A))?.capabilities,
    ["view", "manage_members", "manage_roles"],
    "still exactly what the founder gave them",
  );
});
