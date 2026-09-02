import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedServerRow } from "./infra-test-helpers";
import { reissueBootstrap } from "./servers";

process.env.DEPLO_SECRET = "test-secret-for-bootstrap-url-aaaaaaaa";

/**
 * Which address the install command tells an agent to call home to.
 *
 * During a takeover the panel and its proxy are published on loopback ONLY, so
 * the public address answers nothing and no certificate can be read for it - and
 * that refused every command at the one moment recovering from the panel was the
 * only way out. This host's own agent is bootstrapped over loopback, which is
 * what the installer has always done for it.
 */

let db: TestDb;
let pg: PGlite;

const HOST_IP = "203.0.113.7";
const OTHER = "198.51.100.9";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
  delete process.env.DEPLO_SERVER_IP;
  delete process.env.DEPLO_PUBLIC_URL;
  delete process.env.DEPLO_PANEL_PORT;
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_INFRA}
    truncate table activities, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServerRow(db, {
    id: "srv_host",
    name: "this box",
    ip: HOST_IP,
    host: HOST_IP,
  });
  await seedServerRow(db, {
    id: "srv_far",
    name: "elsewhere",
    ip: OTHER,
    host: OTHER,
  });
  process.env.DEPLO_SERVER_IP = HOST_IP;
  // What a takeover leaves: a public address whose port is bound to loopback, so
  // nothing answers it and no certificate can be read from here.
  process.env.DEPLO_PUBLIC_URL = "https://deplo-cb00710b.invalid:8443";
  process.env.DEPLO_PANEL_PORT = "3001";
});

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("this host's own agent is bootstrapped over loopback, on the port the installer chose", async () => {
  const res = await asOwner(() => reissueBootstrap("srv_host"));
  assert.match(
    res.installCommand,
    /'http:\/\/127\.0\.0\.1:3001\/install-agent\.sh'/,
  );
  assert.match(
    res.installCommand,
    /bash -s -- '[^']+' 'http:\/\/127\.0\.0\.1:3001'$/,
  );
  assert.equal(
    res.installCommand.includes("fsSLk"),
    false,
    "nothing to distrust over loopback",
  );
});

test("with no port declared it is the port a plain install publishes", async () => {
  delete process.env.DEPLO_PANEL_PORT;
  const res = await asOwner(() => reissueBootstrap("srv_host"));
  assert.match(
    res.installCommand,
    /'http:\/\/127\.0\.0\.1:3000\/install-agent\.sh'/,
  );
});

test("another machine still calls home to the address it can reach", async () => {
  const res = await asOwner(() => reissueBootstrap("srv_far"));
  assert.match(
    res.installCommand,
    /'https:\/\/deplo-cb00710b\.invalid:8443\/install-agent\.sh'/,
  );
});
