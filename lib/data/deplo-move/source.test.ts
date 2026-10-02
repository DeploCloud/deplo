import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

process.env.DEPLO_PUBLIC_URL = "https://old.example";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import {
  deploMoves,
  deploMoveServers,
} from "../../db/schema/control-plane/deplo-move";
import { deployments } from "../../db/schema/control-plane/deployments";
import { apps } from "../../db/schema/control-plane/apps";
import { migrationRuns } from "../../db/schema/control-plane/migration";
import { nowIso } from "../../ids";
import { runWithIdentity } from "../../auth/request-context";
import { issueAgentServerCert } from "../../agent/pki";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { AgentUnreachableError } from "../../infra/agent-client/errors";
import { instanceFingerprint } from "../../migration/deplo/instance";
import { schemaTag } from "../../deplo-move/schema-tag";
import {
  MOVE_PEER_HEADER,
  MOVE_PEER_URL_HEADER,
  type MoveStep,
} from "../../deplo-move/protocol";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import {
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "../app-graph-test-helpers";
import { instanceFrozen, invalidateFrozen } from "./freeze";
import { cancelMoveCode, createMoveCode, sourceMoveStatus } from "./source";
import {
  __setDumperForTest,
  __setMoveTimingForTest,
  moveCsr,
  moveDump,
  moveFinish,
  moveFreeze,
  moveHello,
  moveInstall,
  moveThaw,
  type MoveCaller,
} from "./source-api";
import { POST } from "@/app/api/deplo-move/[step]/route";
import { graphql } from "graphql";
import { schema } from "../../graphql/schema";
import { getCurrentUser } from "../../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../../membership";

let db: TestDb;
let pg: PGlite;

const PEER = "peer-instance-1";
const NEW = "https://new.example";
const SRV = "srv_move";
const MEMBER = "user_member";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __setAgentConnectorForTest();
  __setDumperForTest();
  __setMoveTimingForTest();
  invalidateFrozen();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table deplo_moves, activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: MEMBER, teamId: TEAM_B, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServerRow(db, {
    id: SRV,
    name: "web-1",
    ip: "192.0.2.10",
    host: "192.0.2.10",
    agent: {
      port: 9443,
      certFingerprint: "fp-old",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });
  await seedServerRow(db, { id: "srv_never", name: "never-enrolled" });
  __setMoveTimingForTest({ settleMs: 2_000, pollMs: 10, graceMs: 0 });
  __setDumperForTest();
  invalidateFrozen();
  fakeAgent();
});

function fakeAgent(opts: { capabilities?: string[]; install?: string } = {}) {
  const calls = {
    csr: 0,
    installs: [] as { certPem: string; caPem: string }[],
  };
  const conn = {
    hello: async () => ({
      capabilities: opts.capabilities ?? ["cert-renewal"],
      agentVersion: "1.2.3",
    }),
    renewalCsr: async () => {
      calls.csr++;
      return { csrPem: "-----BEGIN CERTIFICATE REQUEST-----\ncsr\n" };
    },
    installRenewedCert: async (req: { certPem: string; caPem: string }) => {
      calls.installs.push(req);
      return opts.install
        ? { ok: false, error: opts.install }
        : { ok: true, error: "" };
    },
    close: () => {},
  };
  __setAgentConnectorForTest(async () => conn as unknown as AgentConnection);
  return calls;
}

const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function mint(): Promise<MoveCaller> {
  const { code } = await asAdmin(() => createMoveCode());
  return { code, peerInstance: PEER, peerUrl: `${NEW}/` };
}

async function messages(): Promise<{ teamId: string; message: string }[]> {
  return db
    .select({ teamId: activities.teamId, message: activities.message })
    .from(activities);
}

async function inEveryTeam(message: string): Promise<void> {
  const teams = (await messages())
    .filter((m) => m.message === message)
    .map((m) => m.teamId)
    .sort();
  assert.deepEqual(teams, [TEAM_A, TEAM_B], `"${message}" in every team`);
}

async function frozenMove(): Promise<MoveCaller> {
  const caller = await mint();
  await moveHello(caller);
  await moveFreeze(caller);
  return caller;
}

async function signedPair() {
  const { certPem, caPem } = await issueAgentServerCert(["192.0.2.10"]);
  return { serverId: SRV, certPem, caPem };
}

async function route(
  step: MoveStep | string,
  init: { code?: string; peer?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    [MOVE_PEER_URL_HEADER]: NEW,
  };
  if (init.code) headers.authorization = `Bearer ${init.code}`;
  if (init.peer !== "") headers[MOVE_PEER_HEADER] = init.peer ?? PEER;
  return POST(
    new Request(`https://old.example/api/deplo-move/${step}`, {
      method: "POST",
      headers,
      body: JSON.stringify(init.body ?? {}),
    }),
    { params: Promise.resolve({ step }) },
  );
}

test("only an instance admin mints a move code", async () => {
  await assert.rejects(
    runWithIdentity({ userId: MEMBER, teamId: TEAM_B }, () => createMoveCode()),
    /instance admin/i,
  );
});

test("a fresh code is armed, hashed, and written to every team", async () => {
  const { code, expiresAt } = await asAdmin(() => createMoveCode());
  assert.match(code, /^dmove_[A-Za-z0-9_-]{32}$/);
  assert.ok(Date.parse(expiresAt) > Date.now() + 59 * 60_000);
  const [row] = await db.select().from(deploMoves);
  assert.equal(row.state, "armed");
  assert.notEqual(row.codeHash, code, "never stored in the clear");
  await inEveryTeam("Created a code to move this Deplo");

  const status = await asAdmin(() => sourceMoveStatus());
  assert.equal(status?.state, "armed");
  assert.equal(status?.servers, 1, "only the enrolled server counts");
});

test("a new code replaces one nothing has frozen", async () => {
  const first = await mint();
  await moveHello(first);
  const second = await mint();
  assert.equal((await db.select().from(deploMoves)).length, 1);
  await assert.rejects(moveHello(first), { status: 401 });
  assert.equal((await moveHello(second)).state, "bound");
});

test("an armed code expires; a bound one does not", async () => {
  const caller = await mint();
  await db
    .update(deploMoves)
    .set({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
  await assert.rejects(moveHello(caller), {
    status: 401,
    message: /expired/,
  });
  assert.equal(await asAdmin(() => sourceMoveStatus()), null);

  const fresh = await mint();
  await moveHello(fresh);
  await db
    .update(deploMoves)
    .set({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
  assert.equal((await moveHello(fresh)).state, "bound");
});

test("the first hello binds the code to that Deplo and describes this one", async () => {
  await seedApp(db, { id: "prj_web", slug: "web", serverId: SRV });
  const caller = await mint();
  const hello = await moveHello(caller);
  assert.equal(hello.schema, schemaTag());
  assert.equal(hello.instance, instanceFingerprint());
  assert.equal(hello.panelUrl, "https://old.example");
  assert.deepEqual(hello.counts, {
    teams: 2,
    users: 2,
    apps: 1,
    databases: 0,
    servers: 2,
  });
  const web = hello.servers.find((s) => s.id === SRV)!;
  assert.deepEqual(
    {
      enrolled: web.enrolled,
      reachable: web.reachable,
      canHandOver: web.canHandOver,
      role: web.role,
      apps: web.apps,
      port: web.port,
      agentVersion: web.agentVersion,
    },
    {
      enrolled: true,
      reachable: true,
      canHandOver: true,
      role: "workloads",
      apps: 1,
      port: 9443,
      agentVersion: "1.2.3",
    },
  );
  const never = hello.servers.find((s) => s.id === "srv_never")!;
  assert.equal(never.enrolled, false);
  assert.equal(never.reachable, false);

  const [row] = await db.select().from(deploMoves);
  assert.equal(row.state, "bound");
  assert.equal(row.peerInstance, PEER);
  assert.equal(row.peerUrl, NEW, "stored as an origin");
});

test("a bound code refuses any other Deplo, and this one", async () => {
  const caller = await mint();
  await moveHello(caller);
  await assert.rejects(moveHello({ ...caller, peerInstance: "someone-else" }), {
    status: 403,
    message: /another Deplo/,
  });
  const self = await mint();
  await assert.rejects(
    moveHello({ ...self, peerInstance: instanceFingerprint() }),
    { status: 403 },
  );
});

test("the agent's lack of cert-renewal shows as cannot hand over", async () => {
  fakeAgent({ capabilities: [] });
  const hello = await moveHello(await mint());
  const web = hello.servers.find((s) => s.id === SRV)!;
  assert.equal(web.reachable, true);
  assert.equal(web.canHandOver, false);
});

test("freeze pauses this Deplo, idempotently, and says so in every team", async () => {
  const caller = await mint();
  await moveHello(caller);
  assert.equal(await instanceFrozen(), null);
  assert.equal((await moveFreeze(caller)).state, "frozen");
  assert.equal((await moveFreeze(caller)).state, "frozen");
  assert.match(
    (await instanceFrozen())!.message,
    /^This Deplo is moving to https:\/\/new\.example\./,
  );
  await inEveryTeam(`Paused changes to move this Deplo to ${NEW}`);
  assert.equal(
    (await messages()).filter((m) => m.message.startsWith("Paused")).length,
    2,
    "the repeat wrote nothing",
  );
  await assert.rejects(
    asAdmin(() => createMoveCode()),
    /moving to/,
  );
});

test("cancelling thaws, until a server was handed over", async () => {
  const caller = await frozenMove();
  await asAdmin(() => cancelMoveCode());
  assert.equal(await instanceFrozen(), null);
  assert.equal((await db.select().from(deploMoves)).length, 0);
  await inEveryTeam("Cancelled moving this Deplo");
  await assert.rejects(moveHello(caller), { status: 401 });

  const again = await frozenMove();
  await moveInstall(again, await signedPair());
  await assert.rejects(
    asAdmin(() => cancelMoveCode()),
    /only go forward/,
  );
  await assert.rejects(moveThaw(again), { status: 409 });
  assert.ok(await instanceFrozen(), "still frozen");
});

test("the new Deplo can thaw a move it has not started handing over", async () => {
  const caller = await frozenMove();
  assert.deepEqual(await moveThaw(caller), { ok: true });
  assert.equal(await instanceFrozen(), null);
});

test("csr and install need a frozen Deplo and an agent that can hand over", async () => {
  const caller = await mint();
  await moveHello(caller);
  await assert.rejects(moveCsr(caller, SRV), { status: 409 });
  await moveFreeze(caller);

  await assert.rejects(moveCsr(caller, "srv_nope"), { status: 404 });
  await assert.rejects(moveCsr(caller, "srv_never"), { status: 409 });
  fakeAgent({ capabilities: [] });
  await assert.rejects(moveCsr(caller, SRV), {
    status: 409,
    message: /too old/,
  });

  const calls = fakeAgent();
  assert.match((await moveCsr(caller, SRV)).csrPem, /CERTIFICATE REQUEST/);
  assert.equal(calls.csr, 1);
});

test("install hands the server over with the new authority", async () => {
  const caller = await frozenMove();
  const calls = fakeAgent();
  const pair = await signedPair();

  await assert.rejects(moveInstall(caller, { ...pair, certPem: "garbage" }), {
    status: 400,
  });
  const other = await issueAgentServerCert(["192.0.2.10"]);
  await assert.rejects(moveInstall(caller, { ...pair, caPem: other.certPem }), {
    status: 400,
    message: /not a certificate authority/,
  });
  assert.equal(calls.installs.length, 0, "nothing reached the agent");

  assert.deepEqual(await moveInstall(caller, pair), { ok: true });
  assert.deepEqual(calls.installs, [
    { certPem: pair.certPem, caPem: pair.caPem },
  ]);
  const [server] = await db.select().from(deploMoveServers);
  assert.equal(server.state, "handed_over");
  assert.equal(server.serverId, SRV);
  await inEveryTeam(`Handed server web-1 over to the Deplo at ${NEW}`);

  await assert.rejects(moveCsr(caller, SRV), {
    status: 409,
    handedOver: true,
  });
});

test("an agent that refuses the certificate leaves the server failed, not handed over", async () => {
  const caller = await frozenMove();
  fakeAgent({ install: "renewed cert does not match the pending renewal key" });
  await assert.rejects(moveInstall(caller, await signedPair()), {
    status: 409,
    message: /refused the new certificate/,
  });
  const [server] = await db.select().from(deploMoveServers);
  assert.equal(server.state, "failed");
  await asAdmin(() => cancelMoveCode());
  assert.equal(await instanceFrozen(), null, "a failed server does not pin it");
});

test("finish needs every enrolled server handed over, then is permanent", async () => {
  const caller = await frozenMove();
  await assert.rejects(moveFinish(caller, { movedTo: NEW }), {
    status: 409,
    message: /web-1/,
  });
  await moveInstall(caller, await signedPair());
  assert.deepEqual(await moveFinish(caller, { movedTo: `${NEW}/` }), {
    state: "moved",
  });
  assert.deepEqual(await moveFinish(caller, { movedTo: NEW }), {
    state: "moved",
  });
  assert.equal(
    (await instanceFrozen())?.message,
    `This Deplo moved to ${NEW}.`,
  );
  await inEveryTeam(`Moved this Deplo to ${NEW}`);
  await assert.rejects(
    asAdmin(() => cancelMoveCode()),
    /already moved/,
  );
  await assert.rejects(
    asAdmin(() => cancelMoveCode({ force: true })),
    /already moved/,
  );
  assert.equal(
    (await instanceFrozen())?.moved,
    true,
    "a resume undoes nothing",
  );
  await assert.rejects(moveDump(caller), { status: 409 });
});

test("finish records a server the new Deplo confirmed when the install answer was lost", async () => {
  const caller = await frozenMove();
  __setAgentConnectorForTest(async () => {
    throw new AgentUnreachableError("certificate signed by unknown authority");
  });
  await assert.rejects(moveInstall(caller, await signedPair()), {
    status: 409,
  });
  await assert.rejects(moveFinish(caller, { movedTo: NEW }), { status: 409 });

  const res = await route("finish", {
    code: caller.code,
    body: { movedTo: NEW, handedOver: [SRV, "srv_unknown"] },
  });
  assert.equal(res.status, 200);
  const [server] = await db.select().from(deploMoveServers);
  assert.equal(server.state, "handed_over");
  assert.equal((await instanceFrozen())?.moved, true);
  await inEveryTeam(`Handed server web-1 over to the Deplo at ${NEW}`);
});

test("the dump waits for a build to settle, then streams", async () => {
  const caller = await mint();
  await moveHello(caller);
  await assert.rejects(moveDump(caller), { status: 409 });
  await moveFreeze(caller);

  await seedApp(db, { id: "prj_web", slug: "web", serverId: SRV });
  await seedDeployment(db, {
    id: "dep_1",
    appId: "prj_web",
    status: "building",
  });
  let seenByDump = "";
  __setDumperForTest(async function* () {
    const [dep] = await db
      .select({ status: deployments.status })
      .from(deployments);
    seenByDump = dep.status;
    yield '{"kind":"begin"}';
    yield '{"kind":"end"}\n';
  });
  setTimeout(() => {
    void db
      .update(deployments)
      .set({ status: "ready" })
      .where(eq(deployments.id, "dep_1"))
      .then(() => {});
  }, 50);
  const started = Date.now();
  const lines: string[] = [];
  for await (const line of await moveDump(caller)) lines.push(line);
  assert.equal(seenByDump, "ready", "the snapshot came after the build");
  assert.ok(Date.now() - started < 1_500, "and did not wait out the deadline");
  assert.deepEqual(lines, ['{"kind":"begin"}', '{"kind":"end"}\n']);
});

test("the route refuses a missing or wrong code, and a wrong peer", async () => {
  assert.equal((await route("hello")).status, 401);
  assert.equal((await route("hello", { code: "dmove_nope" })).status, 401);
  assert.equal((await route("hello", { code: "deplo_token" })).status, 401);
  assert.equal((await route("teleport", { code: "x" })).status, 404);

  const { code } = await mint();
  assert.equal((await route("hello", { code, peer: "" })).status, 400);
  const ok = await route("hello", { code });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { state: string }).state, "bound");

  const wrong = await route("hello", { code, peer: "intruder" });
  assert.equal(wrong.status, 403);
  assert.match(((await wrong.json()) as { error: string }).error, /another/);
});

test("the route streams the dump as NDJSON and maps refusals to JSON", async () => {
  const caller = await frozenMove();
  __setDumperForTest(async function* () {
    yield '{"kind":"begin"}';
    yield '{"kind":"end"}';
  });
  const res = await route("dump", { code: caller.code });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  assert.equal(await res.text(), '{"kind":"begin"}\n{"kind":"end"}\n');

  const csr = await route("csr", {
    code: caller.code,
    body: { serverId: SRV },
  });
  assert.equal(csr.status, 200);
  __setAgentConnectorForTest(async () => {
    throw new AgentUnreachableError("connect ECONNREFUSED");
  });
  const down = await route("csr", {
    code: caller.code,
    body: { serverId: SRV },
  });
  assert.equal(down.status, 409, "never a 502: that reads as this panel down");
  assert.match(((await down.json()) as { error: string }).error, /^web-1: /);

  const install = await route("install", {
    code: caller.code,
    body: { serverId: SRV, certPem: "x", caPem: "y" },
  });
  assert.equal(install.status, 400);
  assert.match(
    ((await install.json()) as { error: string }).error,
    /certificate/,
  );
});

// The new Deplo sent the certificate and never heard back: the agent may or may not have taken it.
async function lostInstall(caller: MoveCaller, serverId = SRV): Promise<void> {
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({
          capabilities: ["cert-renewal"],
          agentVersion: "1",
        }),
        installRenewedCert: async () => {
          throw new AgentUnreachableError("connection reset");
        },
        close: () => {},
      }) as unknown as AgentConnection,
  );
  await assert.rejects(
    moveInstall(caller, { ...(await signedPair()), serverId }),
    {
      status: 409,
    },
  );
  const [row] = await db
    .select()
    .from(deploMoveServers)
    .where(eq(deploMoveServers.serverId, serverId));
  assert.equal(row.state, "waiting");
}

function unreachable(): void {
  __setAgentConnectorForTest(async () => {
    throw new AgentUnreachableError("certificate signed by unknown authority");
  });
}

const WEB2 = "srv_move_2";

async function secondServer(): Promise<void> {
  await seedServerRow(db, {
    id: WEB2,
    name: "web-2",
    ip: "192.0.2.11",
    host: "192.0.2.11",
    agent: {
      port: 9443,
      certFingerprint: "fp-old-2",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });
}

test("a waiting server that still answers here no longer pins the move", async () => {
  const caller = await frozenMove();
  await lostInstall(caller);
  fakeAgent();
  await asAdmin(() => cancelMoveCode());
  assert.equal(await instanceFrozen(), null);
  await inEveryTeam("Cancelled moving this Deplo");
});

test("the probe demotes only the server that answers, with a note", async () => {
  await secondServer();
  const caller = await frozenMove();
  await lostInstall(caller);
  fakeAgent();
  await moveInstall(caller, { ...(await signedPair()), serverId: WEB2 });

  await assert.rejects(
    asAdmin(() => cancelMoveCode()),
    /only go forward/,
  );
  const rows = await db
    .select()
    .from(deploMoveServers)
    .orderBy(deploMoveServers.position);
  assert.deepEqual(
    rows.map((r) => [r.serverId, r.state]),
    [
      [SRV, "failed"],
      [WEB2, "handed_over"],
    ],
  );
  assert.match(rows[0].error, /never reached it/);
});

test("a waiting server that does not answer blocks a plain cancel, which names the forced resume", async () => {
  const caller = await frozenMove();
  await lostInstall(caller);
  unreachable();
  await assert.rejects(
    asAdmin(() => cancelMoveCode()),
    {
      message: /only go forward\. .*resume this Deplo instead/,
    },
  );
  assert.ok(await instanceFrozen(), "still paused");
  const [row] = await db.select().from(deploMoveServers);
  assert.equal(row.state, "waiting", "not demoted on silence");
});

test("an install still in flight is never read as one that did not happen", async () => {
  const caller = await frozenMove();
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let sent = () => {};
  const reached = new Promise<void>((r) => (sent = r));
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({
          capabilities: ["cert-renewal"],
          agentVersion: "1",
        }),
        installRenewedCert: async () => {
          sent();
          await held;
          return { ok: true, error: "" };
        },
        close: () => {},
      }) as unknown as AgentConnection,
  );
  const pair = await signedPair();
  const pending = moveInstall(caller, pair);
  await reached;

  // The agent still answers here: the certificate has not landed yet.
  await assert.rejects(
    asAdmin(() => cancelMoveCode()),
    /only go forward/,
  );
  await assert.rejects(moveInstall(caller, pair), {
    status: 409,
    message: /being handed over already/,
  });
  release();
  assert.deepEqual(await pending, { ok: true });
  const [row] = await db.select().from(deploMoveServers);
  assert.equal(row.state, "handed_over");
});

test("a forced resume thaws past handed-over servers and names them", async () => {
  await secondServer();
  const caller = await frozenMove();
  await moveInstall(caller, await signedPair());
  await lostInstall(caller, WEB2);
  unreachable();

  await asAdmin(() => cancelMoveCode({ force: true }));
  assert.equal(await instanceFrozen(), null, "changes resume");
  await inEveryTeam(
    "Resumed this Deplo without finishing the move; web-1 and web-2 answer to the other Deplo and must be added again.",
  );
  const [move] = await db.select().from(deploMoves);
  assert.equal(move.state, "resumed");
  assert.deepEqual(
    (await db.select().from(deploMoveServers))
      .map((r) => [r.name, r.state])
      .sort(),
    [
      ["web-1", "handed_over"],
      ["web-2", "waiting"],
    ],
    "kept as they are, as the record",
  );
  assert.equal(await asAdmin(() => sourceMoveStatus()), null);

  // The new Deplo coming back finds the code dead.
  await assert.rejects(moveHello(caller), {
    status: 409,
    message: /resumed without finishing/,
  });
  await asAdmin(() => cancelMoveCode({ force: true }));
  assert.equal(
    (await messages()).filter((m) => m.message.startsWith("Resumed")).length,
    2,
    "a second resume writes nothing",
  );
  const next = await mint();
  assert.equal((await moveHello(next)).state, "bound", "a new move can start");
});

test("a forced resume with nothing handed over is a plain cancel", async () => {
  await frozenMove();
  await asAdmin(() => cancelMoveCode({ force: true }));
  assert.equal(await instanceFrozen(), null);
  assert.equal((await db.select().from(deploMoves)).length, 0);
  await inEveryTeam("Cancelled moving this Deplo");
});

test("a forced resume during an install counts that server as gone", async () => {
  const caller = await frozenMove();
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let sent = () => {};
  const reached = new Promise<void>((r) => (sent = r));
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({
          capabilities: ["cert-renewal"],
          agentVersion: "1",
        }),
        installRenewedCert: async () => {
          sent();
          await held;
          return { ok: true, error: "" };
        },
        close: () => {},
      }) as unknown as AgentConnection,
  );
  const pending = moveInstall(caller, await signedPair());
  await reached;

  await asAdmin(() => cancelMoveCode({ force: true }));
  await inEveryTeam(
    "Resumed this Deplo without finishing the move; web-1 answers to the other Deplo and must be added again.",
  );
  release();
  await pending;
  const [row] = await db.select().from(deploMoveServers);
  assert.equal(row.state, "handed_over", "the outcome is still recorded");
  await assert.rejects(moveInstall(caller, await signedPair()), {
    message: /resumed without finishing/,
  });
});

test("thawing a paused Deplo finishes the app deletes a paused boot skipped", async () => {
  await seedApp(db, { id: "prj_gone", slug: "gone", serverId: SRV });
  await db.update(apps).set({ deletingAt: nowIso() });
  await frozenMove();
  await asAdmin(() => cancelMoveCode());
  for (let i = 0; i < 200; i++) {
    const done = (await messages()).some(
      (m) => m.message === "Deleted project prj_gone",
    );
    if (done) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await db.select().from(apps)).length, 0);
});

async function migrationRun(status: string): Promise<void> {
  await db.insert(migrationRuns).values({
    id: `dimp_${status}`,
    teamId: TEAM_A,
    sourceUrl: "https://panel.example",
    actor: "Ada",
    status,
    created: 0,
    skipped: 0,
    failed: 0,
    manual: 0,
    startedAt: nowIso(),
  });
}

test("freeze refuses while a migration runs; a queued one does not count", async () => {
  const caller = await mint();
  await moveHello(caller);
  await migrationRun("queued");
  await migrationRun("running");
  await assert.rejects(moveFreeze(caller), {
    status: 409,
    message:
      "A migration is running on this Deplo. Finish or stop it, then start the move again.",
  });
  assert.equal(await instanceFrozen(), null);

  await db
    .update(migrationRuns)
    .set({ status: "stopped" })
    .where(eq(migrationRuns.status, "running"));
  assert.equal((await moveFreeze(caller)).state, "frozen");
});

test("the dump waits for a migration that slipped past the freeze", async () => {
  const caller = await frozenMove();
  await migrationRun("running");
  let seen = "";
  __setDumperForTest(async function* () {
    const [run] = await db
      .select({ status: migrationRuns.status })
      .from(migrationRuns);
    seen = run.status;
    yield '{"kind":"end"}';
  });
  setTimeout(() => {
    void db
      .update(migrationRuns)
      .set({ status: "done" })
      .then(() => {});
  }, 50);
  for await (const _ of await moveDump(caller)) void _;
  assert.equal(seen, "done");
});

test("the API resumes only when asked to force it", async () => {
  const caller = await frozenMove();
  await moveInstall(caller, await signedPair());
  const identity = { userId: USER_1, teamId: TEAM_A };
  const run = (source: string) =>
    runWithIdentity(identity, async () => {
      const contextValue = {
        viewer: await getCurrentUser(),
        teamId: await getActiveTeamId(),
        capabilities: await reachableCapabilities(),
        via: "cookie" as const,
        identity: null,
      };
      const res = await graphql({ schema, source, contextValue });
      return {
        data: JSON.parse(JSON.stringify(res.data ?? null)),
        errors: (res.errors ?? []).map((e) => e.message),
      };
    });

  const plain = await run("mutation { cancelMoveCode }");
  assert.match(plain.errors[0] ?? "", /resume this Deplo instead/);
  assert.ok(await instanceFrozen());

  assert.deepEqual(await run("mutation { cancelMoveCode(force: true) }"), {
    data: { cancelMoveCode: true },
    errors: [],
  });
  assert.equal(await instanceFrozen(), null);
});
