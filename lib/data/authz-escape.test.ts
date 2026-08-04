import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

// Set BEFORE the modules load: with a configured public URL the deploy hook
// never reaches for request headers, which is what makes it drivable from here.
process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { projects as projectsTable } from "../db/schema/control-plane";
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
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedRun,
  seedS3,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";

import {
  deleteSharedVar,
  listSharedVars,
  revealSharedVar,
  saveSharedVar,
} from "./shared-vars";
import {
  createBackup,
  deleteAllBackupArtifacts,
  deleteBackup,
  restoreBackup,
  runBackup,
  toggleBackup,
  updateBackup,
} from "./backups";
import { createRole, listRoles, resetRole, updateRole } from "./roles";
import { updateMember } from "./members";
import { deployHookUrlMasked, revealDeployHook, verifyDeployHookToken } from "./deploy-hook";

/**
 * ESCAPING YOUR OWN BOUNDARY — the three ways deplo hands out less than
 * everything, and what happens when a caller tries to reach past the line.
 *
 *  1. an API TOKEN narrowed to one Project (the scope tree),
 *  2. a ROLE narrowed by an admin (the roles page),
 *  3. a DEPLOY HOOK, which is one app's URL secret plus a bearer token.
 *
 * The sibling files assert the happy paths and the obvious refusals; this one is
 * about the seams BETWEEN the mechanisms, which is where a boundary leaks:
 *
 *  - a capability that keeps meaning something inside a Project (`manage_env`,
 *    `reveal_secrets`, `manage_backups`) survives the project clamp on purpose,
 *    so every TEAM-LEVEL resource those capabilities also unlock has to refuse a
 *    narrowed token by itself. Shared variables and database backups are the two
 *    that do, and both were reachable before this file existed;
 *  - a role edit rewrites the capabilities of everyone holding the role, the
 *    actor included, so EVERY door into one (author, reset) needs the same bound;
 *  - a hook URL is pasted into third-party systems, so one app's secret must
 *    stay useless against another's, and the masked form must be a mask.
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

/** The same owner over a cookie session — the control for every refusal below. */
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
    assert.fail(`${what} — the call went through`);
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(
      msg,
      /not found|permission|can't access|only|Unauthorized/i,
      `${what} — refused, but for the wrong reason: ${msg}`,
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
    { id: PRC_IN, teamId: TEAM_A, name: "In", slug: "in", createdAt: T0, updatedAt: T0 },
    { id: PRC_OUT, teamId: TEAM_A, name: "Out", slug: "out", createdAt: T0, updatedAt: T0 },
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
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    });
    const found = (await listSharedVars()).find((v) => v.key === "STRIPE_KEY");
    assert.ok(found, "the fixture var exists");
    return found.id;
  });
}

test("a project-scoped token can't read the team's shared secrets back", async () => {
  const id = await teamWideSecret();

  // The control: the same secret, the same user, over a session.
  assert.equal(await asUser(() => revealSharedVar(id)), "sk_live_hunter2");

  await refused(
    () => scoped(() => revealSharedVar(id)),
    "a token limited to one project revealed a team-wide secret",
  );
});

test("nor author one — a team-wide var reaches every app in the team", async () => {
  const id = await teamWideSecret();

  // Creating: the var would be injected into apps in `prc_out` too, at the
  // highest deploy precedence.
  await refused(
    () => scoped(() =>
      saveSharedVar({
        key: "INJECTED",
        value: "x",
        type: "plain",
        teamWide: true,
        environmentIds: [],
        projectIds: [],
      }),
    ),
    "a narrowed token created a team-wide shared variable",
  );

  // Editing an existing one is the same escape with an extra step: rewriting a
  // value every out-of-scope app already consumes.
  await refused(
    () => scoped(() =>
      saveSharedVar({
        id,
        key: "STRIPE_KEY",
        value: "sk_live_attacker",
        type: "secret",
        teamWide: true,
        environmentIds: [],
        projectIds: [],
      }),
    ),
    "a narrowed token rewrote a team-wide shared variable",
  );

  assert.equal(
    await asUser(() => revealSharedVar(id)),
    "sk_live_hunter2",
    "and the stored value is untouched",
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
/* 2. A narrowed API token vs. the team's database backups             */
/* ------------------------------------------------------------------ */

/**
 * A database backup schedule + one successful run. A database belongs to no
 * Project, so NOTHING here is reachable by a project-scoped token — but
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

test("nor run, pause, edit or delete its schedule", async () => {
  const { backupId } = await dbBackup();

  await refused(() => scoped(() => runBackup(backupId)), "runBackup");
  await refused(() => scoped(() => toggleBackup(backupId, false)), "toggleBackup");
  await refused(
    () => scoped(() =>
      updateBackup(backupId, {
        name: "hijacked",
        destinationId: DEST,
        schedule: "0 4 * * *",
        retentionDays: 1,
      }),
    ),
    "updateBackup",
  );
  await refused(() => scoped(() => deleteBackup(backupId)), "deleteBackup");
});

test("nor schedule a new dump of one, nor wipe its artifacts", async () => {
  await dbBackup();

  await refused(
    () => scoped(() =>
      createBackup({
        name: "exfil",
        targetKind: "database",
        databaseId: DB,
        destinationId: DEST,
        schedule: "0 3 * * *",
        retentionDays: 7,
      }),
    ),
    "a narrowed token scheduled a dump of an out-of-scope database",
  );

  await refused(
    () => scoped(() =>
      deleteAllBackupArtifacts({ kind: "database", targetId: DB }),
    ),
    "a narrowed token wiped an out-of-scope database's artifacts",
  );
});

test("and the refusal is scope, not permission — the session still does all of it", async () => {
  const { backupId } = await dbBackup();
  // The control that keeps the fix honest: the same calls, the same user, over a
  // cookie session. If these break, the guard is over-refusing.
  await asUser(() => toggleBackup(backupId, false));
  await asUser(() =>
    updateBackup(backupId, {
      name: "nightly",
      destinationId: DEST,
      schedule: "0 4 * * *",
      retentionDays: 3,
    }),
  );
  await asUser(() =>
    createBackup({
      name: "second",
      targetKind: "database",
      databaseId: DB,
      destinationId: DEST,
      schedule: "0 5 * * *",
      retentionDays: 7,
    }),
  );
  await asUser(() => deleteBackup(backupId));
});

test("an APP backup inside the scope is still reachable — the guard is about databases", async () => {
  const created = await scoped(() =>
    createBackup({
      name: "in-scope",
      targetKind: "app",
      databaseId: null,
      appId: APP_IN,
      destinationId: DEST,
      schedule: "0 3 * * *",
      retentionDays: 7,
    }),
  );
  assert.equal(created.targetKind, "app");

  // ...and the app in the OTHER project is still refused, by the app gate.
  await refused(
    () => scoped(() =>
      createBackup({
        name: "out-of-scope",
        targetKind: "app",
        databaseId: null,
        appId: APP_OUT,
        destinationId: DEST,
        schedule: "0 3 * * *",
        retentionDays: 7,
      }),
    ),
    "a narrowed token scheduled a backup of an out-of-scope app",
  );
});

/* ------------------------------------------------------------------ */
/* 3. Roles — every door into a role carries the same bound            */
/* ------------------------------------------------------------------ */

/** The team's built-in Member role, as stored. */
async function memberRole(): Promise<{ id: string; capabilities: Capability[] }> {
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
  // so it is authoring a role by another name — and it answers to the same bound
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
/* 4. Deploy hooks — one URL secret, one app                           */
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
  // The secret is per app, so holding one app's URL — legitimately, as its
  // deployer — says nothing about any other app's.
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

  assert.ok(masked.startsWith(`https://deplo.test/api/apps/${APP_IN}/deploy-hook/`));
  assert.ok(!masked.includes(secret), "the whole secret is absent");
  // Not even the first characters: a settings page renders this for anyone who
  // can read the app, including members without `configure_apps`.
  assert.ok(
    !masked.includes(secret.slice(0, 4)),
    "nor its leading characters",
  );
});
