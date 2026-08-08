import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  backupDestination as destTable,
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
  seedDestination,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import {
  __resetDnsLookupForTest,
  __setDnsLookupForTest,
  assertSafeOutboundUrl,
  createDestination,
  deleteDestination,
  getDestinationWithSecrets,
  listDestinations,
  destinationTestReport,
  testDestinations,
  toDestinationOption,
  destinationServerId,
} from "./destinations";

/**
 * Data-layer tests for `s3` against pglite (PLAN Step 5, cut-set (d)). Verifies the
 * newest-first SQL list, the masked DTO + decrypted creds for the executor, team
 * isolation, and that `deleteDestination` removes dependent backup schedules AND run history
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

test("createDestination stores encrypted creds; the DTO masks them and starts unverified", async () => {
  await asUser1(async () => {
    const dto = await createDestination({
      kind: "s3",
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
    const list = await listDestinations();
    const creds = await getDestinationWithSecrets(list[0]!.id);
    assert.equal(creds.accessKey, "AKIA");
    assert.equal(creds.secretKey, "s3cret");
  });
  // The raw row never holds the plaintext.
  const rows = await db.select().from(destTable);
  assert.notEqual(decryptSecret(rows[0]!.accessKeyEnc ?? ""), "");
  assert.notEqual(rows[0]!.accessKeyEnc, "AKIA");
});

test("listDestinations is team-scoped and newest-first", async () => {
  await seedDestination(db, { id: "s3_a", name: "a" });
  await db
    .update(destTable)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(destTable.id, "s3_a"));
  await seedDestination(db, { id: "s3_b", name: "b" });
  await db
    .update(destTable)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(destTable.id, "s3_b"));
  await seedDestination(db, { id: "s3_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const list = await listDestinations();
    assert.deepEqual(list.map((s) => s.id), ["s3_b", "s3_a"]);
  });
});

/* ------------------------------------------------------------------ */
/* Probing every destination at once (what the picker opens with)      */
/* ------------------------------------------------------------------ */

/**
 * `testDestinations` is what the destination picker fires when it opens, so the two
 * properties that matter are "every destination gets a verdict" and "one bad
 * destination never sinks the list". The seeded server has no agent certificate,
 * so no host can serve the probe — every destination lands on the SAME recorded
 * failure, which is exactly the case that used to be invisible.
 */
test("testDestinations probes every destination and records each verdict", async () => {
  await seedDestination(db, { id: "s3_a", name: "a", status: "connected" });
  await db
    .update(destTable)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(destTable.id, "s3_a"));
  await seedDestination(db, { id: "s3_b", name: "b", status: "connected" });
  await db
    .update(destTable)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(destTable.id, "s3_b"));
  // Another team's bucket must never be probed on our behalf.
  await seedDestination(db, { id: "s3_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const probed = await testDestinations();
    assert.deepEqual(
      probed.map((d) => d.id),
      ["s3_b", "s3_a"],
      "same order as listDestinations — newest first",
    );
    for (const d of probed) {
      assert.equal(d.status, "error", `${d.id} should be repainted from the live probe`);
      assert.match(d.lastTestError ?? "", /No provisioned server is available/);
      assert.ok(d.lastTestAt, "the probe stamps when it ran");
    }
  });

  // Persisted, not just returned — a reopened dialog reads the same verdict.
  const rows = await db.select().from(destTable).where(eq(destTable.teamId, TEAM_A));
  assert.deepEqual(
    rows.map((r) => r.status).sort(),
    ["error", "error"],
  );
  const foreign = (await db.select().from(destTable).where(eq(destTable.id, "s3_other")))[0]!;
  assert.equal(foreign.status, "connected", "another team's destination is untouched");
});

test("toDestinationOption keeps only what a picker needs, for both kinds", async () => {
  await seedDestination(db, { id: "s3_1", name: "Backups" });
  await asUser1(async () => {
    const [dto] = await listDestinations();
    // No credentials, no region, no test history: a dialog that only chooses a
    // destination has no business shipping any of that to the browser.
    assert.deepEqual(toDestinationOption(dto!), {
      id: "s3_1",
      name: "Backups",
      kind: "s3",
      where: "https://s3.us-east-1.amazonaws.com",
      status: "connected",
      serverId: null,
    });
  });
});

test("toDestinationOption describes a server destination by server and folder", async () => {
  await seedDestination(db, {
    id: "dst_srv",
    name: "Nightly",
    kind: "server",
    serverId: SERVER_1,
  });
  // Whatever the last check resolved is what the picker shows — the folder the
  // agent actually used, not the one that was (or was not) typed.
  await db
    .update(destTable)
    .set({ resolvedPath: "/data/backups" })
    .where(eq(destTable.id, "dst_srv"));
  await asUser1(async () => {
    const dto = (await listDestinations()).find((d) => d.id === "dst_srv")!;
    const opt = toDestinationOption(dto);
    assert.equal(opt.kind, "server");
    assert.equal(opt.serverId, SERVER_1);
    assert.match(opt.where, /\/data\/backups$/);
    assert.ok(!opt.where.startsWith("·"), "the server name comes first");
  });
});

test("a server destination never leaks its private key into a DTO", async () => {
  await seedDestination(db, {
    id: "dst_key",
    kind: "server",
    serverId: SERVER_1,
  });
  await asUser1(async () => {
    const dto = (await listDestinations()).find((d) => d.id === "dst_key")!;
    // The recipient is public and rides along; the identity is the one thing
    // that must only ever leave through revealRecoveryKey, which logs it.
    assert.ok(dto.ageRecipient?.startsWith("age1"));
    assert.equal("ageIdentityEnc" in dto, false);
    assert.equal(JSON.stringify(dto).includes("AGE-SECRET-KEY"), false);
  });
});

test("destinationServerId routes a store to its own host and S3 to the workload's", () => {
  // The distinction retention and delete-with-artifacts would otherwise get
  // wrong, silently: an artifact on another server's disk is only reachable
  // through THAT server's agent.
  assert.equal(
    destinationServerId({ kind: "server", serverId: "srv_store" }, "srv_app"),
    "srv_store",
  );
  assert.equal(
    destinationServerId({ kind: "s3", serverId: null }, "srv_app"),
    "srv_app",
  );
  // A malformed server destination falls back to the workload's host rather
  // than dialing nothing.
  assert.equal(
    destinationServerId({ kind: "server", serverId: null }, "srv_app"),
    "srv_app",
  );
});

test("deleteDestination removes dependent schedules AND run history in one transaction", async () => {
  await seedDatabase(db, { id: "db_1" });
  await seedDestination(db, { id: "s3_1" });
  await seedBackup(db, { id: "bkp_1", destinationId: "s3_1", databaseId: "db_1" });
  await seedRun(db, { id: "brun_1", destinationId: "s3_1", databaseId: "db_1", backupId: "bkp_1" });

  await asUser1(() => deleteDestination("s3_1"));

  assert.equal((await db.select().from(destTable).where(eq(destTable.id, "s3_1"))).length, 0);
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

test("deleteDestination is team-scoped (a foreign destination is not found)", async () => {
  await seedDestination(db, { id: "s3_b", teamId: TEAM_B });
  await asUser1(async () => {
    await assert.rejects(() => deleteDestination("s3_b"), /Not found/);
  });
  // Still present.
  assert.equal((await db.select().from(destTable).where(eq(destTable.id, "s3_b"))).length, 1);
});

/* ------------------------------------------------------------------ */
/* Connection-test report (what the "Connection log" dialog reads)     */
/* ------------------------------------------------------------------ */

/**
 * `destinationTestReport` is a pure READ of the four `last_test_*` columns — opening the
 * log must never re-dial. The probe itself (`testDestination`) needs a live
 * agent, so its verdict-to-report mapping is covered by the pure tests in
 * s3-test-report.test.ts; here we pin what the STORED verdict turns into.
 */
test("destinationTestReport: never tested ⇒ a `never` report, not a failure", async () => {
  await seedDestination(db, { id: "s3_1", name: "Backups", status: "unverified" });
  await asUser1(async () => {
    const r = await destinationTestReport("s3_1");
    assert.equal(r.never, true);
    assert.equal(r.ok, false);
    assert.equal(r.error, "");
    assert.deepEqual(r.steps, []);
    // The reproduce block needs no verdict, so it is there from the start.
    assert.match(r.command, /head-bucket/);
  });
});

test("destinationTestReport: a stored failure keeps the agent's words verbatim", async () => {
  // Give the server a name distinct from its id, so the report proves it
  // resolves the stored server_id to a human label instead of printing the id.
  await db
    .update(serversTable)
    .set({ name: "eu-main-1" })
    .where(eq(serversTable.id, SERVER_1));
  await seedDestination(db, {
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
    const r = await destinationTestReport("s3_1");
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

test("destinationTestReport: a stored PASS reports ok with no error line", async () => {
  await seedDestination(db, {
    id: "s3_1",
    status: "connected",
    lastTest: { at: "2026-07-29T09:00:00.000Z", serverId: SERVER_1, ms: 120 },
  });
  await asUser1(async () => {
    const r = await destinationTestReport("s3_1");
    assert.equal(r.ok, true);
    assert.equal(r.error, "");
    assert.ok(r.steps.every((s) => s.status === "passed"));
  });
});

test("destinationTestReport: the last verdict rides the DTO, so the card can explain the badge", async () => {
  await seedDestination(db, {
    id: "s3_1",
    status: "error",
    lastTest: { at: "2026-07-29T09:00:00.000Z", error: "Access Denied.", ms: 5 },
  });
  await asUser1(async () => {
    const [dto] = await listDestinations();
    assert.equal(dto.lastTestError, "Access Denied.");
    assert.equal(dto.lastTestAt, "2026-07-29T09:00:00.000Z");
  });
});

test("destinationTestReport refuses a cross-team destination", async () => {
  await seedDestination(db, { id: "s3_other", teamId: TEAM_B });
  await assert.rejects(asUser1(() => destinationTestReport("s3_other")), /not found/i);
});

/* ------------------------------------------------------------------ */
/* The outbound guard (SSRF)                                           */
/* ------------------------------------------------------------------ */

/**
 * The control plane dials notification webhooks itself, and the agents dial the
 * S3 endpoint, so these fields are the two places a member picks a URL somebody
 * else's process will fetch. The guard used to inspect only the literal spelling
 * of the host — which stopped `http://169.254.169.254/` and nothing else, since
 * a NAME pointing at the same address sailed past.
 */
test("the outbound guard refuses every private-address literal", async () => {
  const bad = [
    "http://127.0.0.1/x",
    "http://localhost/x",
    "http://10.1.2.3/x",
    "http://172.16.0.9/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/x",
    "http://0177.0.0.1/x", // octal — WHATWG canonicalises it to 127.0.0.1
    "http://[::1]/x",
    "http://[fd00::1]/x",
    "http://[::ffff:127.0.0.1]/x",
  ];
  for (const url of bad) {
    await assert.rejects(
      () => assertSafeOutboundUrl(url, "Endpoint", { allowHttp: true }),
      /private or internal/,
      `${url} must be refused`,
    );
  }
});

test("a hostname is resolved, so a name pointing inside is refused too", async () => {
  __setDnsLookupForTest(async (host) =>
    host === "internal.example.com"
      ? [{ address: "10.0.0.5" }]
      : host === "split.example.com"
        ? [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]
        : [{ address: "93.184.216.34" }],
  );
  try {
    await assert.rejects(
      () => assertSafeOutboundUrl("https://internal.example.com/hook", "Webhook URL"),
      /private or internal/,
      "a name that answers with a private address is the same attack, spelled politely",
    );
    // ANY answer being internal is enough — a round-robin that mixes one in is
    // still a way in.
    await assert.rejects(
      () => assertSafeOutboundUrl("https://split.example.com/hook", "Webhook URL"),
      /private or internal/,
    );
    // The control: a public name passes, and so does the scheme check.
    await assertSafeOutboundUrl("https://hooks.example.com/x", "Webhook URL");
    await assert.rejects(
      () => assertSafeOutboundUrl("http://hooks.example.com/x", "Webhook URL"),
      /must be an https URL/,
    );
  } finally {
    __resetDnsLookupForTest();
  }
});

test("a name that doesn't resolve is left alone, not refused", async () => {
  __setDnsLookupForTest(async () => {
    throw new Error("ENOTFOUND");
  });
  try {
    // Refusing to SAVE a webhook because DNS blipped is the worse trade: the
    // dial fails on its own, and the literal checks already ran.
    await assertSafeOutboundUrl("https://maybe.example.com/x", "Webhook URL");
  } finally {
    __resetDnsLookupForTest();
  }
});
