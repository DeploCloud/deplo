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
  teams as teamsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { decryptSecret } from "../crypto";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, SERVER_1 } from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
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
  ensureDefaultDestination,
  getDestinationWithSecrets,
  listDestinations,
  listDestinationOptions,
  destinationRemovalImpact,
  destinationTestReport,
  revealRecoveryKey,
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
      // Whether there is a key, and whether anyone has taken it. Not the key.
      encrypted: true,
      recoveryKeySavedAt: null,
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

/* ------------------------------------------------------------------ */
/* The default destination is seeded ONCE, and stays deleted           */
/* ------------------------------------------------------------------ */

/**
 * `ensureDefaultDestination` runs on every render of the three pages that show a
 * destination picker. Seeding on "this team has no destinations" therefore made
 * the default UNDELETABLE — Remove deleted the row and the next render put it
 * straight back — and let two concurrent renders each insert one. The claim on
 * `teams.backupDefaultSeededAt` is what fixes both.
 */

/** A server the seed will accept: provisioned, with a pinned agent certificate. */
async function seedBackupCapableServer(): Promise<void> {
  await seedServerRow(db, {
    id: "srv_store",
    name: "store-1",
    ip: "10.0.0.9",
    host: "10.0.0.9",
    agent: {
      port: 9443,
      certFingerprint: "sha256:pinned",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.20.0",
    },
  });
}

const seededFlag = async (): Promise<string | null> =>
  (await db.select().from(teamsTable).where(eq(teamsTable.id, TEAM_A)))[0]
    ?.backupDefaultSeededAt ?? null;

test("the default destination is created once, on a server the team can reach", async () => {
  await seedBackupCapableServer();
  await asUser1(async () => {
    await ensureDefaultDestination();
    await ensureDefaultDestination();
    const list = await listDestinations();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.kind, "server");
    assert.equal(list[0]!.serverId, "srv_store");
    // Encrypted by construction: a recipient to write to, an identity kept here.
    assert.ok(list[0]!.ageRecipient?.startsWith("age1"));
  });
  assert.ok(await seededFlag());
});

test("removing the default destination keeps it removed", async () => {
  await seedBackupCapableServer();
  await asUser1(async () => {
    await ensureDefaultDestination();
    const [seeded] = await listDestinations();
    await deleteDestination(seeded!.id);
    // What the next page render does.
    await ensureDefaultDestination();
    assert.deepEqual(await listDestinations(), []);
  });
});

test("two renders at once seed one destination, not two", async () => {
  await seedBackupCapableServer();
  await asUser1(async () => {
    await Promise.all([ensureDefaultDestination(), ensureDefaultDestination()]);
    assert.equal((await listDestinations()).length, 1);
  });
});

test("a team that already has a destination is never given another", async () => {
  await seedBackupCapableServer();
  await seedDestination(db, { id: "s3_mine", name: "mine" });
  await asUser1(async () => {
    await ensureDefaultDestination();
    assert.deepEqual((await listDestinations()).map((d) => d.id), ["s3_mine"]);
  });
  // The claim is kept, so deleting that one later does not summon a default.
  assert.ok(await seededFlag());
});

test("no backup-capable server yet: nothing is seeded, and the seed can still happen later", async () => {
  // `beforeEach` truncates users/teams/backups, not servers — so clear the one
  // the tests above provisioned. What is left is the seeded server, which has no
  // agent certificate and can therefore hold nothing.
  await db.delete(serversTable).where(eq(serversTable.id, "srv_store"));
  await asUser1(async () => {
    await ensureDefaultDestination();
    assert.deepEqual(await listDestinations(), []);
  });
  assert.equal(await seededFlag(), null);

  await seedBackupCapableServer();
  await asUser1(async () => {
    await ensureDefaultDestination();
    assert.equal((await listDestinations()).length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* A bucket artifact is encrypted too                                   */
/* ------------------------------------------------------------------ */

test("a new S3 destination gets its own keypair, and never leaks the private half", async () => {
  // A project archive carries the app's ENTIRE decrypted env — the restore has
  // to write the real .env back — so the destination shape that shipped first
  // was the one putting every secret in somebody else's storage in the clear.
  await asUser1(async () => {
    const created = await createDestination({
      name: "bucket",
      kind: "s3",
      provider: "aws",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "deplo-backups",
      accessKey: "AKIA_TEST",
      secretKey: "secret_test",
    });
    assert.ok(created.ageRecipient?.startsWith("age1"), "a bucket is encrypted now");
    assert.equal("ageIdentityEnc" in created, false);
    assert.equal(JSON.stringify(created).includes("AGE-SECRET-KEY"), false);
  });
});

test("an S3 destination created before encryption keeps writing plaintext", async () => {
  // Its existing objects already are plaintext, and rewriting history is not on
  // offer — so a null recipient stays null and the run's own key extension is
  // what says which of the two any artifact is.
  await seedDestination(db, { id: "dst_old", kind: "s3", legacyPlaintext: true });
  await asUser1(async () => {
    const dto = (await listDestinations()).find((d) => d.id === "dst_old")!;
    assert.equal(dto.ageRecipient, null);
  });
});

test("a bucket name or region carrying shell syntax is refused at creation", async () => {
  // The connection log prints both into a copy-pasteable `aws …` block, which an
  // admin reaches for exactly when a destination is failing. The report quotes
  // them too; either guard alone is one edit from being the only one.
  await asUser1(async () => {
    await assert.rejects(
      () =>
        createDestination({
          name: "x", kind: "s3", provider: "aws",
          endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1",
          bucket: "b'; rm -rf /; echo '",
          accessKey: "a", secretKey: "s",
        }),
      /bucket names/i,
    );
    await assert.rejects(
      () =>
        createDestination({
          name: "x", kind: "s3", provider: "aws",
          endpoint: "https://s3.us-east-1.amazonaws.com",
          region: "eu-west-1; curl evil",
          bucket: "fine", accessKey: "a", secretKey: "s",
        }),
      /region/i,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Reading destinations without reaching the whole team                 */
/* ------------------------------------------------------------------ */

test("listDestinationOptions carries no credential and no test history", async () => {
  // It is readable by a member scoped to one folder — who may hold
  // `manage_backups` on an app and still needs somewhere to send its backups —
  // so what it carries has to be exactly what a picker shows.
  await seedDestination(db, { id: "dst_s3", kind: "s3" });
  await asUser1(async () => {
    const opts = await listDestinationOptions();
    const one = opts.find((d) => d.id === "dst_s3")!;
    // `encrypted` and `recoveryKeySavedAt` are here on purpose: the Backups tab
    // of an app is where a first schedule is made, and it has to be able to say
    // that those backups are locked by a key nobody has taken yet. Neither is a
    // secret - one is a boolean, the other a timestamp.
    assert.deepEqual(Object.keys(one).sort(), [
      "encrypted", "id", "kind", "name", "recoveryKeySavedAt",
      "serverId", "status", "where",
    ]);
    const json = JSON.stringify(opts);
    assert.equal(json.includes("AKIA"), false);
    assert.equal(json.includes("AGE-SECRET-KEY"), false);
    assert.equal(json.includes("lastTest"), false);
  });
});

test("listDestinationOptions is team-scoped", async () => {
  await seedDestination(db, { id: "dst_mine", kind: "s3" });
  await seedDestination(db, { id: "dst_theirs", kind: "s3", teamId: TEAM_B });
  await asUser1(async () => {
    const ids = (await listDestinationOptions()).map((d) => d.id);
    assert.ok(ids.includes("dst_mine"));
    assert.equal(ids.includes("dst_theirs"), false);
  });
});

/* ------------------------------------------------------------------ */
/* Removing a destination                                               */
/* ------------------------------------------------------------------ */

test("destinationRemovalImpact counts what the confirm dialog has to name", async () => {
  // The dialog used to say backups "will stop running". They do not stop: the
  // schedules and the whole run history are DELETED, and saying so needs numbers.
  await seedDestination(db, { id: "dst_1", kind: "s3" });
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedBackup(db, { id: "bkp_1", destinationId: "dst_1", databaseId: "db_1" });
  await seedRun(db, { id: "r_ok", destinationId: "dst_1", databaseId: "db_1" });
  await seedRun(db, {
    id: "r_bad", destinationId: "dst_1", databaseId: "db_1", status: "failed",
  });
  await asUser1(async () => {
    const impact = await destinationRemovalImpact("dst_1");
    assert.equal(impact.schedules, 1);
    assert.equal(impact.runs, 2, "history, whatever its outcome");
    assert.equal(impact.artifacts, 1, "only a successful run wrote a file");
  });
});

test("an encrypted BUCKET has a recovery key, and an older one honestly has none", async () => {
  // Encryption without a way to get the key back is the trap the whole design
  // exists to avoid: artifacts nobody can read, locked by a key that lives only
  // inside the instance they are meant to survive. Gating this on kind ==
  // "server" recreated it for every bucket the moment buckets were encrypted.
  await asUser1(async () => {
    const bucket = await createDestination({
      name: "encrypted bucket",
      kind: "s3",
      provider: "aws",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "deplo-backups",
      accessKey: "AKIA_TEST",
      secretKey: "secret_test",
    });
    const key = await revealRecoveryKey(bucket.id);
    assert.ok(key.identity.startsWith("AGE-SECRET-KEY"), "the private half comes back");
    assert.equal(key.recipient, bucket.ageRecipient);
    // The file is read in exactly one situation: this instance is gone. A key
    // with no address is most of the way to no key at all, so it carries where
    // the artifacts actually are.
    assert.match(key.where, /deplo-backups/);
    assert.match(key.where, /s3\.us-east-1\.amazonaws\.com/);
  });

  await seedDestination(db, { id: "dst_old", kind: "s3", legacyPlaintext: true });
  await asUser1(async () => {
    await assert.rejects(
      () => revealRecoveryKey("dst_old"),
      /not encrypted/i,
      "a plaintext destination says so rather than pretending to have a key",
    );
  });
});

test("a server destination's key file says which host and which folder", async () => {
  // Same reason as the bucket's: the one screen that could have told them the
  // path is not running any more. An untested destination has no resolved path
  // yet and must still say something an operator can act on, rather than a bare
  // host name and a shrug.
  await seedDestination(db, { id: "dst_where", kind: "server", serverId: SERVER_1 });
  await asUser1(async () => {
    const fresh = await revealRecoveryKey("dst_where");
    assert.match(fresh.where, /managed backups folder/);
  });
  await db
    .update(destTable)
    .set({ resolvedPath: "/data/backups" })
    .where(eq(destTable.id, "dst_where"));
  await asUser1(async () => {
    const probed = await revealRecoveryKey("dst_where");
    assert.match(probed.where, /\/data\/backups/);
  });
});

test("deleteDestination can take the backup files with it, or leave them", async () => {
  // Leaving them was the only option, and for a server destination that meant
  // files on a disk with nothing left in Deplo able to name them - reclaimable
  // only over SSH, which is the one thing this platform exists to remove.
  await seedDestination(db, { id: "dst_keep", kind: "s3" });
  await seedDatabase(db, { id: "db_2", name: "two" });
  await seedRun(db, { id: "r_keep", destinationId: "dst_keep", databaseId: "db_2" });
  await asUser1(async () => {
    await deleteDestination("dst_keep");
  });
  const left = await db.select().from(backupRunsTable);
  assert.equal(
    left.filter((r) => r.id === "r_keep").length,
    0,
    "the records always go with the destination",
  );

  // With the sweep asked for, an unreachable destination ABORTS the removal
  // rather than dropping the rows that name the files.
  await seedDestination(db, { id: "dst_sweep", kind: "s3" });
  await seedRun(db, { id: "r_sweep", destinationId: "dst_sweep", databaseId: "db_2" });
  await asUser1(async () => {
    await assert.rejects(() => deleteDestination("dst_sweep", { deleteArtifacts: true }));
  });
  const survivors = await db.select().from(backupRunsTable);
  assert.equal(
    survivors.filter((r) => r.id === "r_sweep").length,
    1,
    "nothing is dropped while its file is still out there",
  );
});
