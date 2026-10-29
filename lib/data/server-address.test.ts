import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import type { GraphQLObjectType } from "graphql";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
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
    ip: DEAD_LOCAL,
    host: DEAD_LOCAL,
    agent: {
      port: 1,
      certFingerprint: "sha256:pinned",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });
  await seedServerRow(db, {
    id: BARE,
    name: "bare",
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

test("the API names no agent port and no link: a server's address is all it keeps", () => {
  const server = (schema.getType("Server") as GraphQLObjectType).getFields();
  assert.ok(!("agentPort" in server));
  assert.ok(!("linked" in server), "how a server is reached stays out of it");
  const change = schema.getMutationType()!.getFields().updateServerAddress;
  assert.deepEqual(
    change.args.map((a) => a.name).filter((n) => /port/i.test(n)),
    [],
  );
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
    addServer({ name: "v6", host: "[2001:0db8:0:0::1]" }),
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
      () => asAdmin(() => addServer({ name: "x", host })),
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

test("a second server at an address already connected is refused, in any spelling", async () => {
  await asAdmin(() => addServer({ name: "first", host: "2001:db8::1" }));
  await assert.rejects(
    () => asAdmin(() => addServer({ name: "again", host: "[2001:db8:0::1]" })),
    /first is already connected at that address/,
  );
  await assert.rejects(
    () => asAdmin(() => updateServerAddress({ id: BARE, address: DEAD_LOCAL })),
    /provisioned is already connected at that address/,
  );
});
