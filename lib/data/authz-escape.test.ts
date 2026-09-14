import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

// Set BEFORE the modules load: with a public URL the deploy hook never reads request headers.
process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { eq } from "drizzle-orm";

import { sharedEnvVars as sharedEnvVarsTable } from "../db/schema/control-plane/env-vars";
import { projects as projectsTable } from "../db/schema/control-plane/projects";
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
import { ALL_CAPABILITIES, type Capability } from "../types/identity";

import { setSharedVarAppLink } from "./shared-vars/app-links";
import { listSharedVarsForApp } from "./shared-vars/app-view";
import { deleteSharedVar, saveSharedVar } from "./shared-vars/authoring";
import { listSharedVars } from "./shared-vars/team-view";
import { deleteAllBackupArtifacts } from "./backups/artifact-delete";
import { downloadBackupArtifact } from "./backups/download";
import { restoreBackup } from "./backups/restore";
import { runBackup } from "./backups/run-now";
import {
  createBackup,
  deleteBackup,
  toggleBackup,
  updateBackup,
} from "./backups/schedules";
import { revealRecoveryKey } from "./destinations/recovery-key";
import { listApps } from "./apps/listing";
import { createFolder, listFolders, moveAppToFolder } from "./folders";
import { moveAppToProject } from "./projects/placement";
import { resetRole } from "./roles/builtin-roles";
import { createRole, updateRole } from "./roles/role-editing";
import { listRoles } from "./roles/role-list";
import { createToken } from "./tokens/mint";
import { updateMember } from "./members/assignment";
import {
  deployHookUrlMasked,
  revealDeployHook,
  verifyDeployHookToken,
} from "./deploy-hook";

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const PRC_IN = "prc_in";
const PRC_OUT = "prc_out";
const APP_IN = "prj_in";
const APP_OUT = "prj_out";
const DB = "db_main";
const DEST = "s3_main";

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

const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A, token: grant() }, fn);

const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

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

  // The var would be injected into apps in prc_out too, at the highest deploy precedence.
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
  // Only secret rows are masked, so a team-wide plain var is the value itself.
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

  // ADR-0012 "scopes only suggest": over a session the app's page shows the whole team set.
  const mine = await asUser(() => listSharedVarsForApp(APP_IN));
  assert.deepEqual(
    mine.map((v) => v.key).sort(),
    ["SENTRY_DSN", "STRIPE_KEY"],
    "a session still sees the whole team's shared vars from any app",
  );

  // manage_env survives the project clamp, so this page cannot refuse - it must hold the catalogue back.
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

  // Linking is a read-back by other means, which is why the shared library is requireTeamWide.
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

  // The rule is "does this variable pertain to this app", not "is the caller narrowed".
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

// The defence is upstream: move_apps is absent from PROJECT_SCOPED_CAPABILITIES, so the clamp strips it.
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

// A database belongs to no Project, but manage_backups / restore_backups survive the clamp.
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
  await refused(
    () => scoped(() => restoreBackup(runId)),
    "a narrowed token restored a database backup",
  );
});

test("nor download its artifact - a dump is every byte the database holds", async () => {
  const { runId } = await dbBackup();
  // Gated on restore_backups: a dump hands over every byte without touching the live database.
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
  // A destination belongs to the team and no Project, and its key opens every artifact written there.
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
  await asUser(() =>
    updateRole({
      id: member.id,
      name: "Member",
      capabilities: ["view", "manage_roles"],
    }),
  );

  // Reset rewrites every holder's capabilities, so it answers to the same bound as updateRole.
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
  // On the narrowed role, a reset would rewrite their OWN membership_capabilities row.
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
  assert.deepEqual(await verifyDeployHookToken(APP_IN, secretOut), {
    ok: false,
    reason: "bad-token",
  });
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
  // A settings page renders this for anyone who can read the app, configure_apps or not.
  assert.ok(!masked.includes(secret.slice(0, 4)), "nor its leading characters");
});

// memberships.role is a RANK the token clamp does not narrow, so the bound reads capabilities.

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
  // The legacy rank + capabilities path CLAMPS rather than refusing: the proof is the set that lands.
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
  // The legacy role + capabilities path can mint an owner-rank membership holding only some.
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
