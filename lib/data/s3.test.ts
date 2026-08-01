import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  s3Destination as s3Table,
  servers as serversTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { decryptSecret } from "../crypto";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, SERVER_1 } from "./app-graph-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedRun,
  seedS3,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import {
  createS3,
  deleteS3,
  getS3WithSecrets,
  listS3,
  s3TestReport,
  testAllS3,
  toDestinationOption,
} from "./s3";

/**
 * Data-layer tests for `s3` against pglite (PLAN Step 5, cut-set (d)). Verifies the
 * newest-first SQL list, the masked DTO + decrypted creds for the executor, team
 * isolation, and that `deleteS3` removes dependent backup schedules AND run history
 * in ONE transaction (the `destination_id` FK is RESTRICT, so the dependents are
 * deleted explicitly — never cascade-orphaned).
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("createS3 stores encrypted creds; the DTO masks them and starts unverified", async () => {
  await asUser1(async () => {
    const dto = await createS3({
      name: "Backblaze",
      provider: "backblaze-b2",
      endpoint: "https://s3.eu.backblazeb2.com",
      region: "eu",
      bucket: "deplo",
      accessKey: "AKIA",
      secretKey: "s3cret",
    });
    assert.equal(dto.status, "unverified");
    assert.equal(dto.accessKeyMasked, "••••••••");
    assert.equal("accessKeyEnc" in dto, false);
    assert.equal("secretKeyEnc" in dto, false);
  });
  // The stored row holds ciphertext, decryptable by the executor seam.
  await asUser1(async () => {
    const list = await listS3();
    const creds = await getS3WithSecrets(list[0]!.id);
    assert.equal(creds.accessKey, "AKIA");
    assert.equal(creds.secretKey, "s3cret");
  });
  // The raw row never holds the plaintext.
  const rows = await db.select().from(s3Table);
  assert.notEqual(decryptSecret(rows[0]!.accessKeyEnc), "");
  assert.notEqual(rows[0]!.accessKeyEnc, "AKIA");
});

test("listS3 is team-scoped and newest-first", async () => {
  await seedS3(db, { id: "s3_a", name: "a" });
  await db
    .update(s3Table)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(s3Table.id, "s3_a"));
  await seedS3(db, { id: "s3_b", name: "b" });
  await db
    .update(s3Table)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(s3Table.id, "s3_b"));
  await seedS3(db, { id: "s3_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const list = await listS3();
    assert.deepEqual(list.map((s) => s.id), ["s3_b", "s3_a"]);
  });
});

/* ------------------------------------------------------------------ */
/* Probing every destination at once (what the picker opens with)      */
/* ------------------------------------------------------------------ */

/**
 * `testAllS3` is what the destination picker fires when it opens, so the two
 * properties that matter are "every destination gets a verdict" and "one bad
 * destination never sinks the list". The seeded server has no agent certificate,
 * so no host can serve the probe — every destination lands on the SAME recorded
 * failure, which is exactly the case that used to be invisible.
 */
test("testAllS3 probes every destination and records each verdict", async () => {
  await seedS3(db, { id: "s3_a", name: "a", status: "connected" });
  await db
    .update(s3Table)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(s3Table.id, "s3_a"));
  await seedS3(db, { id: "s3_b", name: "b", status: "connected" });
  await db
    .update(s3Table)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(s3Table.id, "s3_b"));
  // Another team's bucket must never be probed on our behalf.
  await seedS3(db, { id: "s3_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const probed = await testAllS3();
    assert.deepEqual(
      probed.map((d) => d.id),
      ["s3_b", "s3_a"],
      "same order as listS3 — newest first",
    );
    for (const d of probed) {
      assert.equal(d.status, "error", `${d.id} should be repainted from the live probe`);
      assert.match(d.lastTestError ?? "", /No provisioned server is available/);
      assert.ok(d.lastTestAt, "the probe stamps when it ran");
    }
  });

  // Persisted, not just returned — a reopened dialog reads the same verdict.
  const rows = await db.select().from(s3Table).where(eq(s3Table.teamId, TEAM_A));
  assert.deepEqual(
    rows.map((r) => r.status).sort(),
    ["error", "error"],
  );
  const foreign = (await db.select().from(s3Table).where(eq(s3Table.id, "s3_other")))[0]!;
  assert.equal(foreign.status, "connected", "another team's destination is untouched");
});

test("toDestinationOption keeps the picker's three facts and nothing else", async () => {
  await seedS3(db, { id: "s3_1", name: "Backups" });
  await asUser1(async () => {
    const [dto] = await listS3();
    assert.deepEqual(toDestinationOption(dto!), {
      id: "s3_1",
      name: "Backups",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      status: "connected",
    });
  });
});

test("deleteS3 removes dependent schedules AND run history in one transaction", async () => {
  await seedDatabase(db, { id: "db_1" });
  await seedS3(db, { id: "s3_1" });
  await seedBackup(db, { id: "bkp_1", destinationId: "s3_1", databaseId: "db_1" });
  await seedRun(db, { id: "brun_1", destinationId: "s3_1", databaseId: "db_1", backupId: "bkp_1" });

  await asUser1(() => deleteS3("s3_1"));

  assert.equal((await db.select().from(s3Table).where(eq(s3Table.id, "s3_1"))).length, 0);
  assert.equal(
    (await db.select().from(backupsTable).where(eq(backupsTable.destinationId, "s3_1"))).length,
    0,
    "dependent schedule removed (RESTRICT FK ⇒ explicit delete)",
  );
  assert.equal(
    (await db.select().from(backupRunsTable).where(eq(backupRunsTable.destinationId, "s3_1"))).length,
    0,
    "dependent run history removed (no dangling destinationId)",
  );
});

test("deleteS3 is team-scoped (a foreign destination is not found)", async () => {
  await seedS3(db, { id: "s3_b", teamId: TEAM_B });
  await asUser1(async () => {
    await assert.rejects(() => deleteS3("s3_b"), /Not found/);
  });
  // Still present.
  assert.equal((await db.select().from(s3Table).where(eq(s3Table.id, "s3_b"))).length, 1);
});

/* ------------------------------------------------------------------ */
/* Connection-test report (what the "Connection log" dialog reads)     */
/* ------------------------------------------------------------------ */

/**
 * `s3TestReport` is a pure READ of the four `last_test_*` columns — opening the
 * log must never re-dial the bucket. The probe itself (`testS3`) needs a live
 * agent, so its verdict-to-report mapping is covered by the pure tests in
 * s3-test-report.test.ts; here we pin what the STORED verdict turns into.
 */
test("s3TestReport: never tested ⇒ a `never` report, not a failure", async () => {
  await seedS3(db, { id: "s3_1", name: "Backups", status: "unverified" });
  await asUser1(async () => {
    const r = await s3TestReport("s3_1");
    assert.equal(r.never, true);
    assert.equal(r.ok, false);
    assert.equal(r.error, "");
    assert.deepEqual(r.steps, []);
    // The reproduce block needs no verdict, so it is there from the start.
    assert.match(r.command, /head-bucket/);
  });
});

test("s3TestReport: a stored failure keeps the agent's words verbatim", async () => {
  // Give the server a name distinct from its id, so the report proves it
  // resolves the stored server_id to a human label instead of printing the id.
  await db
    .update(serversTable)
    .set({ name: "eu-main-1" })
    .where(eq(serversTable.id, SERVER_1));
  await seedS3(db, {
    id: "s3_1",
    name: "Backups",
    status: "error",
    lastTest: {
      at: "2026-07-29T09:00:00.000Z",
      error: 'write probe to bucket "deplo-backups": Access Denied.',
      serverId: SERVER_1,
      ms: 731,
    },
  });
  await asUser1(async () => {
    const r = await s3TestReport("s3_1");
    assert.equal(r.never, false);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'write probe to bucket "deplo-backups": Access Denied.');
    assert.equal(r.durationMs, 731);
    // The stored server_id is resolved to the server's display name.
    assert.equal(r.serverName, "eu-main-1");
    // And the sequence blames the write step (see s3-test-report.test.ts).
    assert.equal(r.steps.find((s) => s.key === "write")?.status, "failed");
  });
});

test("s3TestReport: a stored PASS reports ok with no error line", async () => {
  await seedS3(db, {
    id: "s3_1",
    status: "connected",
    lastTest: { at: "2026-07-29T09:00:00.000Z", serverId: SERVER_1, ms: 120 },
  });
  await asUser1(async () => {
    const r = await s3TestReport("s3_1");
    assert.equal(r.ok, true);
    assert.equal(r.error, "");
    assert.ok(r.steps.every((s) => s.status === "passed"));
  });
});

test("s3TestReport: the last verdict rides the DTO, so the card can explain the badge", async () => {
  await seedS3(db, {
    id: "s3_1",
    status: "error",
    lastTest: { at: "2026-07-29T09:00:00.000Z", error: "Access Denied.", ms: 5 },
  });
  await asUser1(async () => {
    const [dto] = await listS3();
    assert.equal(dto.lastTestError, "Access Denied.");
    assert.equal(dto.lastTestAt, "2026-07-29T09:00:00.000Z");
  });
});

test("s3TestReport refuses a cross-team destination", async () => {
  await seedS3(db, { id: "s3_other", teamId: TEAM_B });
  await assert.rejects(asUser1(() => s3TestReport("s3_other")), /not found/i);
});
