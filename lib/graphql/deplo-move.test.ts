import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { graphql } from "graphql";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../migration/transport";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedServerRow } from "../data/infra-test-helpers";
import { invalidateFrozen } from "../data/deplo-move/freeze";
import { __setPortProbeForTest } from "../data/deplo-move/target";
import {
  MOVE_CODE,
  NEW,
  OLD,
  SELF_IP,
  fakeAgents,
  fakeOldDeplo,
  helloOf,
  summary,
} from "../data/deplo-move/target-test-helpers";
import { schema } from "./schema";
import type { GraphQLContext } from "./context";

let db: TestDb;
let pg: PGlite;

const MEMBER = "user_member";
const T0 = "2026-01-01T00:00:00.000Z";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_PUBLIC_URL = NEW;
  process.env.DEPLO_SERVER_IP = SELF_IP;
});

after(async () => {
  __resetMigrationFetchForTest();
  __setAgentConnectorForTest();
  __setPortProbeForTest();
  invalidateFrozen();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table deplo_moves, deplo_move_servers, servers, apps,
    databases, activities, registration_links, membership_capabilities,
    memberships, users, teams, instance_settings restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: MEMBER, teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServerRow(db, {
    id: "srv_self",
    name: "this-machine",
    ip: SELF_IP,
    host: SELF_IP,
  });
  const agents = fakeAgents();
  __setAgentConnectorForTest(agents.connector);
  const old = fakeOldDeplo(agents, {
    hello: helloOf({ servers: [summary({ id: "srv_web", name: "web" })] }),
  });
  __setMigrationFetchForTest(old.fetch);
  __setPortProbeForTest(async () => true);
  invalidateFrozen();
});

type Principal = { identity: RequestIdentity | null; ctx: GraphQLContext };

const ANONYMOUS: Principal = {
  identity: null,
  ctx: {
    viewer: null,
    teamId: null,
    capabilities: [],
    via: "anonymous",
    identity: null,
  },
};

async function signedIn(userId: string): Promise<Principal> {
  const identity = { userId, teamId: TEAM_A };
  const ctx = await runWithIdentity(
    identity,
    async (): Promise<GraphQLContext> => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    }),
  );
  return { identity, ctx };
}

async function run(
  p: Principal,
  source: string,
  variableValues?: Record<string, unknown>,
) {
  const exec = () =>
    graphql({ schema, source, variableValues, contextValue: p.ctx });
  const res = await (p.identity ? runWithIdentity(p.identity, exec) : exec());
  return {
    // graphql-js builds null-prototype objects; deepEqual wants plain ones.
    data: JSON.parse(JSON.stringify(res.data ?? null)) as Record<
      string,
      unknown
    > | null,
    errors: (res.errors ?? []).map((e) => e.message),
  };
}

const ADMIN_ONLY = [
  "query { sourceMove { id } }",
  "query { targetMove }",
  "query { deploMoveReadiness { ready } }",
  "mutation { createMoveCode { code } }",
  "mutation { cancelMoveCode }",
  `mutation { connectDeploMove(url: "${OLD}", code: "${MOVE_CODE}") { id } }`,
  'mutation { startDeploMove(id: "dmv_any") { id } }',
];

test("every admin field refuses anyone who is not an instance admin", async () => {
  for (const who of [ANONYMOUS, await signedIn(MEMBER)]) {
    for (const doc of ADMIN_ONLY) {
      const res = await run(who, doc);
      assert.ok(res.errors.length > 0, `${doc} answered ${who.ctx.via}`);
    }
  }
  assert.equal(await db.$count(deploMoves), 0, "nothing was written");
});

test("an instance admin mints a code shown once, sees it armed, and withdraws it", async () => {
  const admin = await signedIn(USER_1);
  const minted = await run(
    admin,
    "mutation { createMoveCode { code expiresAt } }",
  );
  assert.deepEqual(minted.errors, []);
  const { code, expiresAt } = minted.data?.createMoveCode as {
    code: string;
    expiresAt: string;
  };
  assert.match(code, /^dmove_/);
  assert.ok(Date.parse(expiresAt) > Date.now());
  const [row] = await db.select().from(deploMoves);
  assert.notEqual(row.codeHash, code, "only a hash is kept");

  const status = await run(
    admin,
    "query { sourceMove { state expiresAt handedOver peerUrl } }",
  );
  assert.deepEqual(status.data?.sourceMove, {
    state: "armed",
    expiresAt,
    handedOver: 0,
    peerUrl: null,
  });

  assert.deepEqual(await run(admin, "mutation { cancelMoveCode }"), {
    data: { cancelMoveCode: true },
    errors: [],
  });
  const gone = await run(admin, "query { sourceMove { id } }");
  assert.equal(gone.data?.sourceMove, null);
});

test("an instance admin connects and reads the preview through the API", async () => {
  const admin = await signedIn(USER_1);
  const busy = await run(
    admin,
    "query { deploMoveReadiness { ready reason } }",
  );
  assert.equal(
    (busy.data?.deploMoveReadiness as { ready: boolean }).ready,
    false,
    "a second account means this Deplo is not fresh",
  );
  await pg.exec(`delete from memberships where user_id = '${MEMBER}';
    delete from users where id = '${MEMBER}';`);
  const ready = await run(
    admin,
    "query { deploMoveReadiness { ready reason } }",
  );
  assert.deepEqual(ready.data?.deploMoveReadiness, {
    ready: true,
    reason: null,
  });

  const res = await run(
    admin,
    `mutation C($url: String!, $code: String!) {
      connectDeploMove(url: $url, code: $code) {
        id peerUrl canStart problems
        counts { teams users }
        servers { name role isPanelHost problem }
      }
    }`,
    { url: OLD, code: MOVE_CODE },
  );
  assert.deepEqual(res.errors, []);
  const preview = res.data?.connectDeploMove as {
    id: string;
    peerUrl: string;
    canStart: boolean;
    servers: unknown[];
  };
  assert.equal(preview.peerUrl, OLD);
  assert.equal(preview.canStart, true);
  assert.deepEqual(preview.servers, [
    { name: "web", role: "workloads", isPanelHost: false, problem: null },
  ]);
  const open = await run(admin, "query { targetMove }");
  assert.equal(open.data?.targetMove, preview.id);
});

test("a move's status is public by its id, and an unknown id is null", async () => {
  const unknown = await run(
    ANONYMOUS,
    'query { deploMoveStatus(id: "dmv_nope") { id } }',
  );
  assert.deepEqual(unknown, { data: { deploMoveStatus: null }, errors: [] });

  await db.insert(deploMoves).values({
    id: "dmv_public",
    side: "target",
    state: "connected",
    peerUrl: OLD,
    startedBy: "user_1",
    createdAt: T0,
    updatedAt: T0,
  });
  const known = await run(
    ANONYMOUS,
    `query { deploMoveStatus(id: "dmv_public") {
      state peerUrl canCancel canRetry canFinishWithoutSource steps { key state }
    } }`,
  );
  assert.deepEqual(known.errors, []);
  assert.deepEqual(known.data?.deploMoveStatus, {
    state: "connected",
    peerUrl: OLD,
    canCancel: true,
    canRetry: false,
    canFinishWithoutSource: false,
    steps: [
      { key: "copy", state: "waiting" },
      { key: "servers", state: "waiting" },
      { key: "finish", state: "waiting" },
    ],
  });
});

test("retry, cancel and finish answer by id with no session, and say plainly when there is no such move", async () => {
  for (const field of [
    "retryDeploMove",
    "cancelDeploMove",
    "finishDeploMoveWithoutSource",
  ]) {
    const res = await run(
      ANONYMOUS,
      `mutation { ${field}(id: "dmv_nope") { id } }`,
    );
    assert.match(res.errors.join(" "), /no such move/, field);
  }

  await db.insert(deploMoves).values({
    id: "dmv_public",
    side: "target",
    state: "connected",
    peerUrl: OLD,
    startedBy: "user_1",
    createdAt: T0,
    updatedAt: T0,
  });
  const early = await run(
    ANONYMOUS,
    'mutation { finishDeploMoveWithoutSource(id: "dmv_public") { state } }',
  );
  assert.match(early.errors.join(" "), /stopped after the copy/);
  const cancelled = await run(
    ANONYMOUS,
    'mutation { cancelDeploMove(id: "dmv_public") { state } }',
  );
  assert.deepEqual(cancelled.errors, []);
  assert.deepEqual(cancelled.data?.cancelDeploMove, { state: "cancelled" });
});
