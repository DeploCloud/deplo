import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { servers } from "../../db/schema/control-plane/servers";
import { storedBootstrapFor } from "../../agent/bootstrap";
import { isDeploHostServer } from "../../deploy/domains";
import { seedServerRow, TRUNCATE_INFRA } from "../infra-test-helpers";
import { ensureDeploHostServer } from "./enrollment";
import { linksOverLoopback } from "./panel-address";
import { getServerById, listAllServers } from "./roster";

// ADR-0050: the host running Deplo is the server its installer enrolled, never the one at the machine's address.

let db: TestDb;
let pg: PGlite;
const ENV = [
  "DEPLO_HOST_BOOTSTRAP_TOKEN",
  "DEPLO_SERVER_IP",
  "DEPLO_PUBLIC_URL",
  "DEPLO_LINK_PORT",
] as const;
const saved: Record<string, string | undefined> = {};

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  await pg.exec(TRUNCATE_INFRA);
});

afterEach(() => {
  for (const k of ENV)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
});

const hosts = async () =>
  (await listAllServers()).filter((s) => isDeploHostServer(s)).map((s) => s.id);

test("behind NAT, the host is the server its installer enrolled, though its address is not the machine's", async () => {
  process.env.DEPLO_HOST_BOOTSTRAP_TOKEN = "host-token";
  process.env.DEPLO_SERVER_IP = "203.0.113.200";
  process.env.DEPLO_LINK_PORT = "3101";
  await seedServerRow(db, {
    id: "srv_home",
    ip: "198.51.100.44",
    host: "198.51.100.44",
    bootstrap: storedBootstrapFor("host-token"),
  });
  // Another machine at the address the installer saw: behind the same router, never the host.
  await seedServerRow(db, {
    id: "srv_neighbour",
    ip: "203.0.113.200",
    host: "203.0.113.200",
  });
  await ensureDeploHostServer();
  assert.deepEqual(await hosts(), ["srv_home"]);
  const home = (await getServerById("srv_home"))!;
  assert.equal(linksOverLoopback(home), true, "its agent links over loopback");
  assert.equal(
    linksOverLoopback((await getServerById("srv_neighbour"))!),
    false,
  );
});

test("a first install creates its host marked", async () => {
  process.env.DEPLO_HOST_BOOTSTRAP_TOKEN = "fresh-token";
  process.env.DEPLO_SERVER_IP = "203.0.113.30";
  await ensureDeploHostServer();
  const all = await listAllServers();
  assert.equal(all.length, 1);
  assert.equal(all[0].deploHost, true);
  assert.equal(
    all[0].bootstrap?.tokenHash,
    storedBootstrapFor("fresh-token").tokenHash,
  );
  await ensureDeploHostServer();
  assert.equal((await listAllServers()).length, 1, "a restart adds nothing");
});

test("an install from before the mark is recognised by its address once, then by the mark wherever it moves", async () => {
  process.env.DEPLO_SERVER_IP = "203.0.113.10";
  await seedServerRow(db, {
    id: "srv_old",
    ip: "203.0.113.10",
    host: "203.0.113.10",
  });
  await seedServerRow(db, {
    id: "srv_remote",
    ip: "198.51.100.7",
    host: "198.51.100.7",
  });
  await ensureDeploHostServer();
  assert.deepEqual(await hosts(), ["srv_old"]);

  await db
    .update(servers)
    .set({ ip: "192.0.2.50", host: "192.0.2.50" })
    .where(eq(servers.id, "srv_old"));
  process.env.DEPLO_SERVER_IP = "198.51.100.7";
  await ensureDeploHostServer();
  assert.deepEqual(
    await hosts(),
    ["srv_old"],
    "the mark, not the address, decides",
  );
});
