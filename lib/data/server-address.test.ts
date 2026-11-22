import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { graphql, type GraphQLObjectType } from "graphql";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import type { GraphQLContext } from "../graphql/context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedServerRow } from "./infra-test-helpers";
import { listActivity } from "./activity";
import { updateServerAddress } from "./servers/agent-maintenance";
import { addServer } from "./servers/enrollment";
import { getServerById } from "./servers/roster";
import { schema } from "../graphql/schema";

process.env.DEPLO_SECRET = "test-secret-for-server-address-aaaaaaaa";

let db: TestDb;
let pg: PGlite;

const PROVISIONED = "srv_addr_prov";
const BARE = "srv_addr_bare";
// Nothing answers there, and no link comes: the address must save all the same.
const DEAD_LOCAL = "127.0.0.1";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_INFRA}
    truncate table activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "user_member",
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
      },
    ],
  });
  await seedServerRow(db, {
    id: PROVISIONED,
    name: "provisioned",
    // Only a migration source takes an address; Deplo finds every other server's (ADR-0050).
    importOnly: true,
    ip: DEAD_LOCAL,
    host: DEAD_LOCAL,
    agent: {
      certFingerprint: "sha256:pinned",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });
  await seedServerRow(db, {
    id: BARE,
    name: "bare",
    importOnly: true,
    ip: "192.0.2.10",
    host: "192.0.2.10",
    status: "provisioning",
  });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("refuses a caller who is not instance admin", async () => {
  await assert.rejects(() =>
    runWithIdentity({ userId: "user_member", teamId: TEAM_A }, () =>
      updateServerAddress({ id: BARE, address: "192.0.2.20" }),
    ),
  );
  assert.equal((await asAdmin(() => getServerById(BARE)))?.ip, "192.0.2.10");
});

test("refuses a blank address", async () => {
  await assert.rejects(
    () => asAdmin(() => updateServerAddress({ id: BARE, address: "   " })),
    /Address is required/,
  );
});

test("an unprovisioned server: both columns follow the address", async () => {
  await asAdmin(() => updateServerAddress({ id: BARE, address: "192.0.2.20" }));
  const server = await asAdmin(() => getServerById(BARE));
  assert.equal(server?.ip, "192.0.2.20");
  assert.equal(server?.host, "192.0.2.20");
});

test("a provisioned server's new address is saved at once, without Deplo contacting it", async () => {
  const started = Date.now();
  await asAdmin(() =>
    updateServerAddress({ id: PROVISIONED, address: "192.0.2.99" }),
  );
  assert.ok(Date.now() - started < 2_000, "it waited for nothing");
  const server = await asAdmin(() => getServerById(PROVISIONED));
  assert.equal(server?.ip, "192.0.2.99");
  assert.equal(server?.host, "192.0.2.99");
  assert.equal(server?.agent?.certFingerprint, "sha256:pinned", "trust kept");
});

test("Activity names the new address", async () => {
  await asAdmin(() => updateServerAddress({ id: BARE, address: "192.0.2.20" }));
  await asAdmin(() =>
    updateServerAddress({ id: PROVISIONED, address: "192.0.2.99" }),
  );
  const messages = (
    await asAdmin(() => listActivity(10, { types: ["server"] }))
  ).map((a) => a.message);
  assert.deepEqual(messages.sort(), [
    "Changed server bare address to 192.0.2.20",
    "Changed server provisioned address to 192.0.2.99",
  ]);
});

test("the API names no link: a server's address is all it keeps", () => {
  const server = (schema.getType("Server") as GraphQLObjectType).getFields();
  assert.ok(!("linked" in server), "how a server is reached stays out of it");
});

async function asClient(
  userId: string,
  source: string,
): Promise<{ data: Record<string, unknown> | null; errors: string[] }> {
  return runWithIdentity({ userId, teamId: TEAM_A }, async () => {
    const res = await graphql({
      schema,
      source,
      contextValue: {
        viewer: await getCurrentUser(),
        teamId: await getActiveTeamId(),
        capabilities: await reachableCapabilities(),
        via: "cookie",
        identity: null,
      } satisfies GraphQLContext,
    });
    return {
      data: (res.data as Record<string, unknown> | null) ?? null,
      errors: (res.errors ?? []).map((e) => e.message),
    };
  });
}

// An API client written against the release before still validates for one release; each field is deprecated.
test("an older API client's agent port is read as none, and ignored when it sends one", async () => {
  const read = await asClient(
    USER_1,
    `{ server(id: "${PROVISIONED}") { agentPort } }`,
  );
  assert.deepEqual(read.errors, []);
  assert.equal((read.data?.server as { agentPort: unknown }).agentPort, null);

  for (const [type, name] of [
    ["Server", "agentPort"],
    ["DeploMovePreviewServer", "port"],
  ])
    assert.ok(
      (schema.getType(type) as GraphQLObjectType).getFields()[name]
        ?.deprecationReason,
      `${type}.${name} is deprecated`,
    );
});

// Nobody types a server's address any more: Deplo finds them and uses one once it reaches the server.
test("no API takes a typed address for an ordinary server", async () => {
  assert.equal(
    schema.getMutationType()!.getFields().updateServerAddress,
    undefined,
  );
  await seedServerRow(db, {
    id: "srv_plain",
    name: "plain",
    ip: "192.0.2.30",
    host: "192.0.2.30",
  });
  await assert.rejects(
    () =>
      asAdmin(() =>
        updateServerAddress({ id: "srv_plain", address: "192.0.2.31" }),
      ),
    /Deplo finds a server's addresses itself/,
  );
  await assert.rejects(
    () => asAdmin(() => addServer({ name: "typed", host: "192.0.2.32" })),
    /Deplo finds a server's addresses itself/,
  );
  const added = await asClient(
    USER_1,
    `mutation { addServer(input: { name: "typed", host: "192.0.2.33" }) { server { id } } }`,
  );
  assert.match(
    added.errors[0] ?? "",
    /Deplo finds a server's addresses itself/,
  );
});

test("an older API client's update stop lists are empty, and leaving a server behind is refused in plain words", async () => {
  const stop = schema.getType("UpdateStop") as GraphQLObjectType;
  for (const name of ["waitingOn", "leftBehind"])
    assert.ok(stop.getFields()[name]?.deprecationReason, `${name} deprecated`);
  const read = await asClient(
    USER_1,
    `{ updateInfo { stop { version waitingOn { id name } leftBehind { id name } } } }`,
  );
  assert.deepEqual(read.errors, []);

  const leave = schema.getMutationType()!.getFields().leaveServerBehind;
  assert.ok(leave?.deprecationReason, "leaveServerBehind is deprecated");
  const LEAVE = `mutation { leaveServerBehind(id: "${PROVISIONED}") { current } }`;
  const admin = await asClient(USER_1, LEAVE);
  assert.deepEqual(admin.errors, [
    "Deplo no longer waits on servers to update, so there is no server to leave behind.",
  ]);
  const member = await asClient("user_member", LEAVE);
  assert.equal(member.errors.length, 1);
  assert.doesNotMatch(member.errors[0], /no longer waits/);
});

test("keepHost writes only the address in use, leaving the one it was registered at", async () => {
  await asAdmin(() =>
    updateServerAddress({ id: BARE, address: "192.0.2.20", keepHost: true }),
  );
  const server = await asAdmin(() => getServerById(BARE));
  assert.equal(server?.ip, "192.0.2.20");
  assert.equal(server?.host, "192.0.2.10");
});

test("an unchanged address is a no-op", async () => {
  await asAdmin(() =>
    updateServerAddress({ id: PROVISIONED, address: DEAD_LOCAL }),
  );
  assert.deepEqual(await asAdmin(() => listActivity(10)), []);
});

test("every spelling of an IPv6 address is stored one way, on add and on change", async () => {
  const { server } = await asAdmin(() =>
    addServer({ name: "v6", host: "[2001:0db8:0:0::1]", importOnly: true }),
  );
  assert.equal(server.host, "2001:db8::1");
  assert.equal(server.ip, "2001:db8::1");
  await asAdmin(() =>
    updateServerAddress({ id: BARE, address: "2001:DB8::5" }),
  );
  assert.equal((await asAdmin(() => getServerById(BARE)))?.ip, "2001:db8::5");
});

test("an address that is no IP and no host name is refused, on add and on change", async () => {
  for (const host of ["not an address!", "2001:db8::1::2"]) {
    await assert.rejects(
      () => asAdmin(() => addServer({ name: "x", host, importOnly: true })),
      /Enter an IP address or a host name/,
      host,
    );
    await assert.rejects(
      () => asAdmin(() => updateServerAddress({ id: BARE, address: host })),
      /Enter an IP address or a host name/,
      host,
    );
  }
});

test("two servers may share one address: several machines behind one router (ADR-0050)", async () => {
  // Neither is added at an address: each is known by its agent's key, and Deplo finds where it answers.
  const first = await asAdmin(() => addServer({ name: "first" }));
  const again = await asAdmin(() => addServer({ name: "again" }));
  assert.notEqual(first.server.id, again.server.id);
  await asAdmin(() => updateServerAddress({ id: BARE, address: DEAD_LOCAL }));
  await asAdmin(() =>
    updateServerAddress({ id: PROVISIONED, address: DEAD_LOCAL }),
  );
  assert.equal((await getServerById(BARE))?.ip, DEAD_LOCAL);
});
