import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { strandedByPanelUpdate, targetAgentMin } from "./stranded-servers";

let db: TestDb;
let pg: PGlite;
let orig: typeof fetch;
const seen: string[] = [];
const DIALS = { deplo: { agent: "0.6.0", agentMin: "0.5.0" } };
let body: unknown = DIALS;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table servers, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A }] });
  orig = globalThis.fetch;
  seen.length = 0;
  body = DIALS;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = orig;
});

let n = 0;
const seed = (id: string, status: "online" | "offline", version: string) =>
  seedServerRow(db, {
    id,
    name: id,
    status,
    ip: `10.0.2.${++n}`,
    agent: { certFingerprint: `fp_${id}`, certPem: "pem", version },
  });

const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("the floor is read off the tag's package.json, not the API", async () => {
  assert.equal(await targetAgentMin("0.6.0"), "0.5.0");
  assert.deepEqual(seen, [
    "https://raw.githubusercontent.com/DeploCloud/deplo/v0.6.0/package.json",
  ]);
});

test("only offline servers below the new floor are named", async () => {
  await seed("srv_off_old", "offline", "0.4.0");
  await seed("srv_off_ok", "offline", "0.5.1");
  await seed("srv_on_old", "online", "0.4.0");
  const stranded = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_A },
    () => strandedByPanelUpdate("0.6.0"),
  );
  assert.deepEqual(
    stranded.map((s) => [s.name, s.reinstall]),
    [["srv_off_old", false]],
  );
});

test("a release that declares no floor names nobody", async () => {
  body = { version: "0.4.9" };
  await seed("srv_off_old", "offline", "0.1.0");
  const stranded = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_A },
    () => strandedByPanelUpdate("0.4.9"),
  );
  assert.deepEqual(stranded, []);
});

// This Deplo already reaches servers only over their link: a later release strands none by it.
test("an update from a Deplo that only links names no server for not linking", async () => {
  body = {
    deplo: {
      agent: "0.5.1-canary.10",
      agentMin: "0.5.1-canary.10",
      linkOnly: true,
    },
  };
  await seed("srv_up", "online", "0.5.1-canary.10");
  await seed("srv_away", "offline", "0.5.1-canary.10");
  const stranded = await asAdmin(() => strandedByPanelUpdate("0.7.0"));
  assert.deepEqual(stranded, []);
});
