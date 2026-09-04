import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

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
import { ALL_CAPABILITIES } from "../types";

import { listTokens, createToken } from "./tokens";
import { listMembers } from "./members";
import { listRoles } from "./roles";
import { listRegistries } from "./registries";
import { listDestinations } from "./destinations";
import { listDatabases, getDatabase, getConnectionString } from "./databases";
import { listGithubApps } from "./github";
import { listNotificationChannels } from "./notifications";
import { getTeam } from "./teams";
import { listSharedVars } from "./shared-vars";
import { getServer, listServers, getPrimaryServer } from "./servers";

/**
 * What a project-scoped API token is refused OUTRIGHT.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const PRC = "prc_in";
const LIMITED = /limited to specific projects/;

const grant: TokenGrant = {
  id: "tok_test",
  capabilities: [...ALL_CAPABILITIES],
  scope: {
    teamIds: [TEAM_A],
    wholeTeamIds: [],
    projectIds: [PRC],
    folderIds: [],
    appIds: [],
    appProjectIds: [],
  },
  instanceAdmin: false,
};

const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A, token: grant }, fn);

const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(
    `truncate table projects, api_tokens restart identity cascade;`,
  );
  await seedIdentity(db);
  await db.insert(projectsTable).values({
    id: PRC,
    teamId: TEAM_A,
    name: "In",
    slug: "in",
    createdAt: T0,
    updatedAt: T0,
  });
});

test("every team-wide collection is refused, and says why", async () => {
  await scoped(async () => {
    await assert.rejects(() => listMembers(), LIMITED);
    await assert.rejects(() => listRoles(), LIMITED);
    await assert.rejects(() => listRegistries(), LIMITED);
    await assert.rejects(() => listDestinations(), LIMITED);
    await assert.rejects(() => listDatabases(), LIMITED);
    await assert.rejects(() => listGithubApps(), LIMITED);
    await assert.rejects(() => listNotificationChannels(), LIMITED);
    await assert.rejects(() => getTeam(), LIMITED);
    await assert.rejects(() => listSharedVars(), LIMITED);
    // A host has no per-Project meaning either: its name, address and live
    // metrics belong to the team, not to one project inside it.
    await assert.rejects(() => listServers(), LIMITED);
    await assert.rejects(() => getPrimaryServer(), LIMITED);
  });
});

test("the same reads all work over a cookie session", async () => {
  await asUser(async () => {
    assert.ok(Array.isArray(await listTokens()));
    assert.ok(Array.isArray(await listMembers()));
    assert.ok(Array.isArray(await listRoles()));
    assert.ok(Array.isArray(await listDatabases()));
    assert.ok(await getTeam());
  });
});

test("a point lookup by id reads as NOT FOUND, never as a scope error", async () => {
  await scoped(async () => {
    assert.equal(await getServer("srv_whatever"), null);
    assert.equal(await getDatabase("db_whatever"), null);
    // Never the scope message: that would confirm the id is worth guessing at.
    await assert.rejects(
      () => getConnectionString("db_whatever"),
      (e: Error) => !LIMITED.test(e.message),
    );
  });
});

test("a scoped token can't mint itself an unscoped successor", async () => {
  await scoped(async () => {
    await assert.rejects(
      () => createToken({ name: "Escape", capabilities: ["view"] }),
      /can't mint an unscoped token/i,
    );
  });
});

test("a token lists only itself, never its owner's other credentials", async () => {
  const other = await asUser(() =>
    createToken({ name: "Other", capabilities: ["view"] }),
  );
  await scoped(async () => {
    const mine = await listTokens();
    assert.ok(!mine.some((t) => t.id === other.token.id), "a sibling leaked");
  });
});
