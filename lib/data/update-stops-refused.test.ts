import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { refusalReason } from "../db/update-stops";
import { DEPLO_VERSION } from "../version";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { lastRefusedUpdate } from "./update-stops/refused";

let db: TestDb;
let pg: PGlite;
let dataDir: string;

const ADMIN = "admin1";
const MEMBER = "member2";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  dataDir = await mkdtemp(join(tmpdir(), "deplo-data-"));
  process.env.DEPLO_DATA_DIR = dataDir;
});

after(async () => {
  __resetTestDb();
  await pg.close();
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(dataDir, "refused-update"), { force: true });
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: ADMIN, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: MEMBER, teamId: TEAM_A }, fn);

// What install.sh leaves after a rollback (lib/agent/install-script/refused-update.test.ts).
const leaveNote = (version: string, reason: string) =>
  writeFile(
    join(dataDir, "refused-update"),
    `version=${version}\nreason=${reason}\nat=2026-10-27T14:00:05Z\n`,
  );

test("after a rollback, the update decision names the refused version and why", async () => {
  await leaveNote("99.0.0", refusalReason("98.0.0"));
  assert.deepEqual(await asAdmin(lastRefusedUpdate), {
    version: "v99.0.0",
    reason: refusalReason("98.0.0"),
    at: "2026-10-27T14:00:05Z",
  });
});

test("nothing is named once an update to that version, or past it, has landed", async () => {
  assert.equal(await asAdmin(lastRefusedUpdate), null, "no rollback yet");
  for (const version of [DEPLO_VERSION, "0.1.0"]) {
    await leaveNote(version, "It did not start.");
    assert.equal(await asAdmin(lastRefusedUpdate), null, version);
  }
});

test("only an instance admin reads it", async () => {
  await leaveNote("99.0.0", "It did not start.");
  await assert.rejects(() => asMember(lastRefusedUpdate));
});
