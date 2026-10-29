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
let body: unknown = { deplo: { agent: "0.7.0", agentMin: "0.6.0" } };

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

test("the floor is read off the tag's package.json, not the API", async () => {
  assert.equal(await targetAgentMin("0.6.0"), "0.6.0");
  assert.deepEqual(seen, [
    "https://raw.githubusercontent.com/DeploCloud/deplo/v0.6.0/package.json",
  ]);
});

test("only offline servers below the new floor are named, not one only a reinstall brings back", async () => {
  await seed("srv_off_old", "offline", "0.5.1");
  await seed("srv_off_ok", "offline", "0.6.0");
  await seed("srv_on_old", "online", "0.5.1");
  // Too old to connect, it is unusable already: the update changes nothing for it.
  await seed("srv_off_gone", "offline", "0.4.0");
  const stranded = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_A },
    () => strandedByPanelUpdate("0.6.0"),
  );
  assert.deepEqual(
    stranded.map((s) => s.name),
    ["srv_off_old"],
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
