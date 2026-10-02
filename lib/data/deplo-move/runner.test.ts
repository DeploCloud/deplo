import { X509Certificate } from "node:crypto";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { caCertPem } from "../../agent/pki";
import { runWithIdentity } from "../../auth/request-context";
import { encryptSecret } from "../../crypto";
import { __resetTestDb, __setTestDb } from "../../db/client";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { activities } from "../../db/schema/control-plane/activity";
import {
  deploMoves,
  deploMoveServers,
} from "../../db/schema/control-plane/deplo-move";
import { users } from "../../db/schema/control-plane/identity";
import {
  serverTeams,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { instanceFingerprint } from "../../migration/deplo/instance";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../../migration/transport";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { makeServer, seedServerRow } from "../infra-test-helpers";
import { serverToRow } from "../infra-rows";
import { dumpInstance } from "./dump";
import { instanceFrozen, invalidateFrozen } from "./freeze";
import {
  COPY_FAILED,
  HANDOVER_FAILED,
  LEFT_BEHIND_NOTE,
  UNREACHABLE_NOTE,
  __setAfterMoveForTest,
  __setRestorerForTest,
  __waitForMoveForTest,
  resumeDeploMoves,
} from "./runner";
import {
  __setPortProbeForTest,
  cancelMove,
  connectMove,
  finishMoveWithoutSource,
  moveStatus,
  retryMove,
  startMove,
} from "./target";
import {
  MOVE_CODE,
  NEW,
  OLD,
  SELF_IP,
  dumpOf,
  fakeAgents,
  fakeOldDeplo,
  foreignAgentCert,
  helloOf,
  stepsCalled,
  stubRestore,
  summary,
  type FakeOldDeplo,
} from "./target-test-helpers";

let db: TestDb;
let pg: PGlite;
let agents: ReturnType<typeof fakeAgents>;
let old: FakeOldDeplo;
let afterMoves = 0;

const T0 = "2026-01-01T00:00:00.000Z";

const SOURCE_SERVERS = [
  makeServer({
    id: "srv_panel",
    name: "old-panel",
    ip: "198.51.100.20",
    host: "198.51.100.20",
    agent: {
      port: 9443,
      certFingerprint: "fp-old-panel",
      certPem: "old",
      version: "0.5.0",
    },
  }),
  makeServer({
    id: "srv_web",
    name: "web",
    ip: "198.51.100.10",
    host: "198.51.100.10",
    agent: {
      port: 9443,
      certFingerprint: "fp-old-web",
      certPem: "old",
      version: "0.5.0",
    },
  }),
  makeServer({
    id: "srv_spare",
    name: "spare",
    ip: "198.51.100.30",
    host: "198.51.100.30",
  }),
];

function sourceDump(
  extra: Record<string, Record<string, unknown>[]> = {},
): string[] {
  return dumpOf({
    teams: ["team_src1", "team_src2"].map((id) => ({
      id,
      name: id,
      slug: id,
      plan: "pro",
      createdAt: T0,
    })),
    users: [
      {
        id: "user_src",
        email: "ada@old.test",
        username: "ada",
        name: "Ada",
        role: "owner",
        isInstanceAdmin: true,
        avatarColor: "#abc",
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    servers: SOURCE_SERVERS.map(serverToRow),
    ...extra,
  });
}

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
  __setRestorerForTest();
  __setAfterMoveForTest();
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
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServerRow(db, {
    id: "srv_self",
    name: "this-machine",
    ip: SELF_IP,
    host: SELF_IP,
    agent: {
      port: 9443,
      certFingerprint: "fp-self",
      certPem: "self",
      version: "0.5.0",
    },
  });
  agents = fakeAgents();
  __setAgentConnectorForTest(agents.connector);
  old = fakeOldDeplo(agents, {
    hello: helloOf({
      servers: [
        summary({
          id: "srv_panel",
          name: "old-panel",
          address: "198.51.100.20",
          isPanelHost: true,
        }),
        summary({ id: "srv_web", name: "web", address: "198.51.100.10" }),
        summary({
          id: "srv_spare",
          name: "spare",
          address: "198.51.100.30",
          enrolled: false,
          port: null,
        }),
      ],
    }),
    dump: sourceDump(),
  });
  __setMigrationFetchForTest(old.fetch);
  __setPortProbeForTest(async () => true);
  __setRestorerForTest(stubRestore);
  afterMoves = 0;
  __setAfterMoveForTest(async () => {
    afterMoves += 1;
  });
  invalidateFrozen();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function startedMove(): Promise<string> {
  const preview = await asAdmin(() =>
    connectMove({ url: OLD, code: MOVE_CODE }),
  );
  assert.equal(preview.canStart, true, preview.problems.join(" "));
  await asAdmin(() => startMove(preview.id));
  await __waitForMoveForTest();
  return preview.id;
}

async function serverRow(id: string) {
  const [row] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, id));
  return row;
}

async function moveServers(moveId: string) {
  return db
    .select()
    .from(deploMoveServers)
    .where(eq(deploMoveServers.moveId, moveId))
    .orderBy(deploMoveServers.position);
}

test("a move copies, hands every server over with the panel's machine last, and finishes", async () => {
  const id = await startedMove();

  const status = await moveStatus(id);
  assert.equal(status?.state, "done", status?.error ?? "");
  assert.deepEqual(
    status?.steps.map((s) => s.state),
    ["done", "done", "done"],
  );
  assert.equal(status?.rowsCopied, 6);
  assert.deepEqual(stepsCalled(old), [
    "hello",
    "hello",
    "freeze",
    "hello",
    "dump",
    "csr:srv_web",
    "install:srv_web",
    "csr:srv_panel",
    "install:srv_panel",
    "finish",
  ]);

  const ca = await caCertPem();
  for (const call of old.calls) {
    assert.equal(call.headers.get("authorization"), `Bearer ${MOVE_CODE}`);
    assert.equal(call.headers.get("x-deplo-move-peer"), instanceFingerprint());
    assert.equal(call.headers.get("x-deplo-move-peer-url"), NEW);
    if (call.step === "install") assert.equal(call.body.caPem, ca);
  }
  assert.equal(old.calls.at(-1)?.body.movedTo, NEW);

  for (const sid of ["srv_web", "srv_panel"]) {
    const row = await serverRow(sid);
    assert.equal(row.agentCertFingerprint, agents.installed.get(sid));
    assert.match(row.agentCertPem ?? "", /BEGIN CERTIFICATE/);
  }
  assert.equal((await serverRow("srv_spare")).agentCertFingerprint, null);
  assert.equal((await serverRow("srv_self")).agentCertFingerprint, "fp-self");

  assert.deepEqual(
    (await moveServers(id)).map((s) => [
      s.serverId,
      s.position,
      s.state,
      s.error,
    ]),
    [
      ["srv_web", 0, "handed_over", ""],
      ["srv_panel", 1, "handed_over", ""],
    ],
  );

  const notes = await db.select().from(activities);
  assert.deepEqual(notes.map((a) => [a.teamId, a.message]).sort(), [
    ["team_src1", `Moved this Deplo here from ${OLD}`],
    ["team_src2", `Moved this Deplo here from ${OLD}`],
  ]);
  assert.equal(afterMoves, 1);
  invalidateFrozen();
  assert.equal(await instanceFrozen(), null);
});

test("a server this machine cannot reach after the install is still handed over, with a note", async () => {
  agents.unreachable.add("srv_web");
  const id = await startedMove();

  const status = await moveStatus(id);
  assert.equal(status?.state, "done");
  const web = status?.servers.find((s) => s.id === "srv_web");
  assert.equal(web?.state, "handed_over");
  assert.equal(web?.error, UNREACHABLE_NOTE);
});

test("a failed install stops the move on that server, refuses a cancel, and a retry resumes there", async () => {
  old.fail.install = {
    status: 409,
    error: "old-panel: The server agent did not answer.",
    serverId: "srv_panel",
    times: 1,
  };
  const id = await startedMove();

  let status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.equal(
    status?.error,
    "old-panel was not handed over: old-panel: The server agent did not answer.",
  );
  assert.deepEqual(
    status?.steps.map((s) => s.state),
    ["done", "failed", "waiting"],
  );
  assert.deepEqual(
    status?.servers.map((s) => [s.id, s.state]),
    [
      ["srv_web", "handed_over"],
      ["srv_panel", "failed"],
    ],
  );
  assert.equal(status?.canRetry, true);
  assert.equal(status?.canCancel, false);

  await assert.rejects(() => cancelMove(id), /can only go forward/);
  assert.equal(stepsCalled(old).includes("thaw"), false);

  const before = old.calls.length;
  await retryMove(id);
  await __waitForMoveForTest();
  status = await moveStatus(id);
  assert.equal(status?.state, "done", status?.error ?? "");
  assert.deepEqual(stepsCalled(old).slice(before), [
    "csr:srv_panel",
    "install:srv_panel",
    "finish",
  ]);
});

test("a retry after an install whose answer was lost finds the server already handed over", async () => {
  old.fail.install = {
    status: 409,
    error: "The connection dropped.",
    serverId: "srv_web",
    times: 1,
    applied: true,
  };
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "failed");

  const before = old.calls.length;
  await retryMove(id);
  await __waitForMoveForTest();
  assert.equal((await moveStatus(id))?.state, "done");
  assert.deepEqual(stepsCalled(old).slice(before), [
    "csr:srv_panel",
    "install:srv_panel",
    "finish",
  ]);
});

test("a cut-off copy fails the copy step and a retry copies again", async () => {
  old.dump = sourceDump().slice(0, -1);
  const id = await startedMove();

  let status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.match(status?.error ?? "", /cut off/);
  assert.deepEqual(
    status?.steps.map((s) => s.state),
    ["failed", "waiting", "waiting"],
  );

  old.dump = sourceDump();
  await retryMove(id);
  await __waitForMoveForTest();
  status = await moveStatus(id);
  assert.equal(status?.state, "done", status?.error ?? "");
  assert.equal(stepsCalled(old).filter((s) => s === "dump").length, 2);
});

test("cancelling before any server is handed over resumes the old Deplo and wipes the copy", async () => {
  old.fail.csr = {
    status: 409,
    error: "web: The server agent did not answer.",
    serverId: "srv_web",
  };
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "failed");
  assert.equal((await moveStatus(id))?.canCancel, true);

  const status = await cancelMove(id);
  assert.equal(status.state, "cancelled");
  assert.equal(status.error, "");
  assert.equal(stepsCalled(old).at(-1), "thaw");
  assert.equal((await db.select().from(users)).length, 0);
  assert.match(status.setupPath ?? "", /^\/setup\?key=.+/);
  assert.ok(await serverRow("srv_self"), "this machine's own server stays");
  invalidateFrozen();
  assert.equal(await instanceFrozen(), null);
});

test("cancelling a move that never started keeps this Deplo's own account", async () => {
  const preview = await asAdmin(() =>
    connectMove({ url: OLD, code: MOVE_CODE }),
  );
  const status = await cancelMove(preview.id);
  assert.equal(status.state, "cancelled");
  assert.equal(stepsCalled(old).at(-1), "thaw");
  assert.equal((await db.select().from(users)).length, 1);
  assert.equal(status.setupPath, null);
});

test("cancelling when the old Deplo is unreachable still cancels here, and says so", async () => {
  const preview = await asAdmin(() =>
    connectMove({ url: OLD, code: MOVE_CODE }),
  );
  __setMigrationFetchForTest(async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  });
  const status = await cancelMove(preview.id);
  assert.equal(status.state, "cancelled");
  assert.match(status.error, /cancel the move there too/);
});

test("a move left half-way resumes on boot from the first server not handed over", async () => {
  for (const s of SOURCE_SERVERS) await seedServerRow(db, s);
  await db.insert(deploMoves).values({
    id: "dmv_resume",
    side: "target",
    state: "handing_over",
    codeEnc: encryptSecret(MOVE_CODE),
    peerUrl: OLD,
    peerInstance: "old-instance-fingerprint",
    startedBy: "Ada",
    rowsCopied: 6,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(deploMoveServers).values([
    {
      moveId: "dmv_resume",
      serverId: "srv_web",
      name: "web",
      position: 0,
      state: "handed_over",
      updatedAt: T0,
    },
    {
      moveId: "dmv_resume",
      serverId: "srv_panel",
      name: "old-panel",
      position: 1,
      state: "waiting",
      updatedAt: T0,
    },
  ]);

  await resumeDeploMoves();
  await __waitForMoveForTest();

  assert.equal((await moveStatus("dmv_resume"))?.state, "done");
  assert.deepEqual(stepsCalled(old), [
    "csr:srv_panel",
    "install:srv_panel",
    "finish",
  ]);
});

test("with the real copy engine, the old Deplo's rows replace this one's and this machine's server stays", async () => {
  await pg.exec(`truncate table servers, activities, registration_links,
    membership_capabilities, memberships, users, teams, instance_settings
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: "team_src1", slug: "acme" }],
    users: [{ id: "user_src", teamId: "team_src1", role: "owner" }],
  });
  for (const s of SOURCE_SERVERS) await seedServerRow(db, s);
  const lines: string[] = [];
  for await (const line of dumpInstance()) lines.push(line);

  await pg.exec(`truncate table servers, activities, registration_links,
    membership_capabilities, memberships, users, teams, instance_settings
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServerRow(db, {
    id: "srv_self",
    name: "this-machine",
    ip: SELF_IP,
    host: SELF_IP,
  });
  old.dump = lines;
  __setRestorerForTest();

  const id = await startedMove();

  const status = await moveStatus(id);
  assert.equal(status?.state, "done", status?.error ?? "");
  assert.ok((status?.rowsCopied ?? 0) > 0);
  assert.deepEqual(
    (await db.select({ id: users.id }).from(users)).map((u) => u.id),
    ["user_src"],
  );
  assert.ok(await serverRow("srv_self"), "this machine's own server stays");
  for (const sid of ["srv_web", "srv_panel"])
    assert.equal(
      (await serverRow(sid)).agentCertFingerprint,
      agents.installed.get(sid),
    );
});

const oldDeploGone = () =>
  __setMigrationFetchForTest(async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  });

async function quietly<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const said: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  for (const k of ["error", "warn", "log"] as const)
    console[k] = (...args: unknown[]) =>
      said.push(
        args
          .map((a) => (typeof a === "string" ? a : inspect(a, { depth: 8 })))
          .join(" "),
      );
  try {
    return [await fn(), said.join("\n")];
  } finally {
    Object.assign(console, saved);
  }
}

test("a cancel after an install whose answer was lost finds the server answering here and refuses", async () => {
  old.fail.install = {
    status: 409,
    error: "The connection dropped.",
    serverId: "srv_web",
    times: 1,
    applied: true,
  };
  const id = await startedMove();
  let status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.equal(status?.canCancel, true);

  await assert.rejects(
    () => cancelMove(id),
    (e: Error) =>
      e.message ===
      "web already answers to this Deplo, so the move can only go forward.",
  );
  assert.equal(stepsCalled(old).includes("thaw"), false);
  assert.deepEqual(
    (await db.select({ id: users.id }).from(users)).map((u) => u.id),
    ["user_src"],
    "nothing was wiped",
  );
  status = await moveStatus(id);
  assert.equal(
    status?.servers.find((s) => s.id === "srv_web")?.state,
    "handed_over",
  );
  assert.equal(status?.canCancel, false);
});

test("with the old Deplo gone, a cancel refuses while a server may answer here, then the move finishes without it", async () => {
  old.fail.install = {
    status: 409,
    error: "The server agent did not answer.",
    serverId: "srv_web",
    times: 1,
  };
  const id = await startedMove();
  const before = await moveStatus(id);
  assert.equal(before?.state, "failed");
  assert.equal(before?.canFinishWithoutSource, true);

  await assert.rejects(
    () => finishMoveWithoutSource(id),
    /The old Deplo answers again: try again instead\./,
  );
  oldDeploGone();
  await assert.rejects(
    () => cancelMove(id),
    (e: Error) =>
      e.message ===
      "The old Deplo cannot be reached, and web may already answer to this Deplo. Try again once the old Deplo is back, or finish without it.",
  );
  assert.equal((await moveStatus(id))?.state, "failed");
  assert.equal((await db.select().from(users)).length, 1, "nothing was wiped");

  const status = await finishMoveWithoutSource(id);
  assert.equal(status.state, "done");
  assert.equal(
    status.error,
    "Finished without the old Deplo: 2 servers were left behind.",
  );
  assert.deepEqual(
    status.servers.map((s) => [s.id, s.state, s.error]),
    [
      ["srv_web", "failed", LEFT_BEHIND_NOTE],
      ["srv_panel", "failed", LEFT_BEHIND_NOTE],
    ],
  );
  assert.deepEqual(
    status.steps.map((s) => s.state),
    ["done", "failed", "done"],
  );
  assert.ok(status.finishedAt);
  assert.equal(status.canFinishWithoutSource, false);
  assert.equal(afterMoves, 1);
  invalidateFrozen();
  assert.equal(await instanceFrozen(), null);
  await assert.rejects(() => finishMoveWithoutSource(id), /already finished/);
});

test("when the old Deplo resumes, a cancel goes ahead even after an install that may have happened", async () => {
  old.fail.install = {
    status: 409,
    error: "The server agent did not answer.",
    serverId: "srv_web",
    times: 1,
  };
  const id = await startedMove();
  const status = await cancelMove(id);
  assert.equal(status.state, "cancelled");
  assert.equal(stepsCalled(old).at(-1), "thaw");
  assert.equal((await db.select().from(users)).length, 0);
});

test("a server that answers here stays when the move finishes without the old Deplo", async () => {
  old.fail.csr = {
    status: 409,
    error: "old-panel: The server agent did not answer.",
    serverId: "srv_panel",
  };
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "failed");
  oldDeploGone();

  const status = await finishMoveWithoutSource(id);
  assert.equal(
    status.error,
    "Finished without the old Deplo: 1 server was left behind.",
  );
  assert.deepEqual(
    status.servers.map((s) => [s.id, s.state]),
    [
      ["srv_web", "handed_over"],
      ["srv_panel", "failed"],
    ],
  );
  const notes = await db.select().from(activities);
  assert.ok(
    notes.some((a) =>
      /without the old one at https:\/\/old\.deplo\.test: 1 server stays with it$/.test(
        a.message,
      ),
    ),
  );
});

test("a move can only finish without the old Deplo once its copy landed", async () => {
  old.dump = sourceDump().slice(0, -1);
  const id = await startedMove();
  const status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.equal(status?.canFinishWithoutSource, false);
  oldDeploGone();
  await assert.rejects(
    () => finishMoveWithoutSource(id),
    /Only a move that stopped after the copy/,
  );
  await assert.rejects(
    () => finishMoveWithoutSource("dmv_nope"),
    /no such move/,
  );
});

test("a certificate from the old Deplo's CA, which has the same name, never counts as handed over", async () => {
  old.fail.csr = {
    status: 409,
    error: "web: The server agent did not answer.",
    serverId: "srv_web",
  };
  const id = await startedMove();
  const pem = await foreignAgentCert();
  const ours = new X509Certificate(await caCertPem());
  assert.equal(new X509Certificate(pem).checkIssued(ours), true, "same name");
  await db
    .update(serversTable)
    .set({ agentCertPem: pem })
    .where(eq(serversTable.id, "srv_web"));
  oldDeploGone();

  const status = await cancelMove(id);
  assert.equal(status.state, "cancelled");
  assert.match(status.error, /cancel the move there too/);
});

test("a setup key the operator chose is never handed out after a cancel", async () => {
  old.fail.csr = {
    status: 409,
    error: "web: The server agent did not answer.",
    serverId: "srv_web",
  };
  const id = await startedMove();
  process.env.DEPLO_SETUP_KEY = "operator-chosen-key";
  try {
    const status = await cancelMove(id);
    assert.equal(status.state, "cancelled");
    assert.equal(status.setupPath, null);
  } finally {
    delete process.env.DEPLO_SETUP_KEY;
  }
  assert.match((await moveStatus(id))?.setupPath ?? "", /^\/setup\?key=.+/);
});

test("a database error during the copy never reaches the status or the log", async () => {
  const secret = "scrypt$16384$8$1$c2VjcmV0$leaked-hash";
  __setRestorerForTest(async () => {
    throw Object.assign(
      new Error(
        `Failed query: insert into "users" select * from json_populate_recordset(null::"users", $1::json)\nparams: [{"email":"ada@old.test","password":"${secret}"}]`,
      ),
      {
        query: 'insert into "users" select * from json_populate_recordset(...)',
        params: [`[{"email":"ada@old.test","password":"${secret}"}]`],
        cause: Object.assign(new Error(`duplicate key value: ${secret}`), {
          code: "23505",
          table: "users",
          constraint: "users_email_key",
          detail: `Key (password)=(${secret}) already exists.`,
        }),
      },
    );
  });
  const [id, said] = await quietly(() => startedMove());

  const status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.equal(status?.error, COPY_FAILED);
  assert.ok(!said.includes(secret), said);
  assert.ok(!said.includes("ada@old.test"), said);
  assert.match(said, /code 23505, table users, constraint users_email_key/);
});

test("a database error while handing a server over is named, never quoted", async () => {
  await pg.exec(`
    create function deny_new_cert() returns trigger language plpgsql as $$
    begin
      if new.agent_cert_pem like '%BEGIN CERTIFICATE%' then
        raise exception 'refused %', new.agent_cert_pem;
      end if;
      return new;
    end $$;
    create trigger deny_new_cert before update on servers
      for each row execute function deny_new_cert();`);
  try {
    const [id, said] = await quietly(() => startedMove());
    const status = await moveStatus(id);
    assert.equal(status?.state, "failed");
    assert.equal(status?.error, `web was not handed over: ${HANDOVER_FAILED}`);
    assert.equal(
      status?.servers.find((s) => s.id === "srv_web")?.error,
      HANDOVER_FAILED,
    );
    assert.ok(!said.includes("BEGIN CERTIFICATE"), said);
    assert.match(said, /a database error \(code P0001/);
  } finally {
    await pg.exec(`drop trigger deny_new_cert on servers;
      drop function deny_new_cert();`);
  }
});

test("this machine takes the old panel machine's team access instead of every team", async () => {
  old.dump = sourceDump({
    servers: SOURCE_SERVERS.map((s) =>
      serverToRow(s.id === "srv_panel" ? { ...s, allTeams: false } : s),
    ),
    serverTeams: [{ serverId: "srv_panel", teamId: "team_src1" }],
  });
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "done");

  assert.equal((await serverRow("srv_self")).allTeams, false);
  const grants = await db
    .select()
    .from(serverTeams)
    .orderBy(serverTeams.serverId);
  assert.deepEqual(
    grants.map((g) => [g.serverId, g.teamId]),
    [
      ["srv_panel", "team_src1"],
      ["srv_self", "team_src1"],
    ],
  );
});

test("with no old panel machine listed, this machine's team access is left as it was", async () => {
  old.hello.servers = old.hello.servers.map((s) => ({
    ...s,
    isPanelHost: false,
  }));
  old.dump = sourceDump({
    servers: SOURCE_SERVERS.map((s) =>
      serverToRow(s.id === "srv_panel" ? { ...s, allTeams: false } : s),
    ),
  });
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "done");
  assert.equal((await serverRow("srv_self")).allTeams, true);
});
