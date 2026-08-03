import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  folderGrants as folderGrantsTable,
  folders as foldersTable,
} from "../db/schema/control-plane";
import { runWithIdentity, type TokenGrant } from "../auth/request-context";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { nodeCapabilities } from "./node-access";
import type { Capability } from "../types";

/**
 * The API-token intersection at the NODE level (ADR-0016 §8).
 *
 * A node grant REPLACES the membership capability set, so it never passes through
 * the clamp `membershipFor` applies — `lib/data/node-access.ts` has to apply the
 * same one itself. Without that single line a CI token holding only `deploy_apps`
 * would silently inherit its creator's `manage_env` grant on a folder, which is
 * the exact impersonation ADR-0015 removed. This file is what keeps it honest.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const DEV = "u_dev";
const FLD = "fld_prod";
const APP = "prj_in_prod";

const ROLE_CAPS: Capability[] = ["view", "deploy_apps"];

const grant = (over: Partial<TokenGrant> = {}): TokenGrant => ({
  id: "tok_test",
  capabilities: ["view", "deploy_apps"],
  scope: {
    teamIds: [TEAM_A],
    wholeTeamIds: [TEAM_A],
    projectIds: [],
    folderIds: [],
    appIds: [],
    appProjectIds: [],
  },
  instanceAdmin: false,
  ...over,
});

const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: DEV, teamId: TEAM_A }, fn);

const asToken = <T>(fn: () => Promise<T>, over?: Partial<TokenGrant>): Promise<T> =>
  runWithIdentity({ userId: DEV, teamId: TEAM_A, token: grant(over) }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table
    app_grants, folder_grants, project_grants,
    app_build_method_settings, app_build, apps, folders, projects, servers,
    membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: DEV, teamId: TEAM_A, role: "member", isInstanceAdmin: false, capabilities: ROLE_CAPS },
    ],
  });
  await seedServer(db);
  await db.insert(foldersTable).values({
    id: FLD,
    teamId: TEAM_A,
    name: "Prod",
    parentId: null,
    color: null,
    ownerUserId: null,
    projectId: null,
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, { id: APP, teamId: TEAM_A, folderId: FLD });
  // The creator holds a node grant that EXCEEDS their team role.
  await db.insert(folderGrantsTable).values(
    (["manage_env", "delete_apps"] as Capability[]).map((c) => ({
      folderId: FLD,
      userId: DEV,
      capability: c,
    })),
  );
});

test("a token never inherits its creator's node grant", async () => {
  // Over a cookie session the grant applies in full.
  const mine = await asUser(() => nodeCapabilities({ kind: "app", id: APP }));
  assert.ok(mine.includes("manage_env"));
  assert.ok(mine.includes("delete_apps"));

  // The same request made with a token that was granted neither must hold neither.
  const viaToken = await asToken(() => nodeCapabilities({ kind: "app", id: APP }));
  assert.ok(!viaToken.includes("manage_env"), "the token's own set is the ceiling");
  assert.ok(!viaToken.includes("delete_apps"));
});

test("a token holding the capability keeps it at the node", async () => {
  const viaToken = await asToken(
    () => nodeCapabilities({ kind: "app", id: APP }),
    { capabilities: ["view", "manage_env"] },
  );
  assert.ok(viaToken.includes("manage_env"), "granted to both ⇒ it applies");
  assert.ok(!viaToken.includes("delete_apps"), "and nothing else leaks through");
});

test("a NARROWED token also loses the team-wide capabilities at a node", async () => {
  // Scoped below the whole team (to this one app), so PROJECT_SCOPED_CAPABILITIES
  // applies on top of the token's own set — same rule as everywhere else.
  const viaToken = await asToken(
    () => nodeCapabilities({ kind: "app", id: APP }),
    {
      capabilities: ["view", "manage_env", "manage_members"],
      scope: {
        teamIds: [TEAM_A],
        wholeTeamIds: [],
        projectIds: [],
        folderIds: [FLD],
        appIds: [],
        appProjectIds: [],
      },
    },
  );
  assert.ok(viaToken.includes("manage_env"));
  assert.ok(!viaToken.includes("manage_members"), "team-wide caps drop for a narrowed token");
});
