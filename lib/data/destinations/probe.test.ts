import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { TEAM_A, TEAM_B } from "../identity-test-helpers";
import { SERVER_1 } from "../app-graph-test-helpers";
import { seedDestination } from "../backup-test-helpers";
import { listDestinations } from "./listing";
import { destinationTestReport, testDestinations } from "./probe";
import {
  TRUNCATE,
  asUser1,
  seedDestinationFixtures,
} from "./destinations-test-helpers";

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
  await pg.exec(TRUNCATE);
  await seedDestinationFixtures(db);
});

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
  await seedDestination(db, { id: "s3_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const probed = await testDestinations();
    assert.deepEqual(
      probed.map((d) => d.id),
      ["s3_b", "s3_a"],
      "same order as listDestinations - newest first",
    );
    for (const d of probed) {
      assert.equal(
        d.status,
        "error",
        `${d.id} should be repainted from the live probe`,
      );
      assert.match(d.lastTestError ?? "", /No provisioned server is available/);
      assert.ok(d.lastTestAt, "the probe stamps when it ran");
    }
  });

  const rows = await db
    .select()
    .from(destTable)
    .where(eq(destTable.teamId, TEAM_A));
  assert.deepEqual(rows.map((r) => r.status).sort(), ["error", "error"]);
  const foreign = (
    await db.select().from(destTable).where(eq(destTable.id, "s3_other"))
  )[0]!;
  assert.equal(
    foreign.status,
    "connected",
    "another team's destination is untouched",
  );
});

test("destinationTestReport: never tested ⇒ a `never` report, not a failure", async () => {
  await seedDestination(db, {
    id: "s3_1",
    name: "Backups",
    status: "unverified",
  });
  await asUser1(async () => {
    const r = await destinationTestReport("s3_1");
    assert.equal(r.never, true);
    assert.equal(r.ok, false);
    assert.equal(r.error, "");
    assert.deepEqual(r.steps, []);
    assert.match(r.command, /head-bucket/);
  });
});

test("destinationTestReport: a stored failure keeps the agent's words verbatim", async () => {
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
    assert.equal(
      r.error,
      'write probe to bucket "deplo-backups": Access Denied.',
    );
    assert.equal(r.durationMs, 731);
    assert.equal(r.serverName, "eu-main-1");
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
    lastTest: {
      at: "2026-07-29T09:00:00.000Z",
      error: "Access Denied.",
      ms: 5,
    },
  });
  await asUser1(async () => {
    const [dto] = await listDestinations();
    assert.equal(dto.lastTestError, "Access Denied.");
    assert.equal(dto.lastTestAt, "2026-07-29T09:00:00.000Z");
  });
});

test("destinationTestReport refuses a cross-team destination", async () => {
  await seedDestination(db, { id: "s3_other", teamId: TEAM_B });
  await assert.rejects(
    asUser1(() => destinationTestReport("s3_other")),
    /not found/i,
  );
});

test("a probe that cannot reach the host keeps the last measurement", async () => {
  await seedDestination(db, {
    id: "dst_1",
    kind: "server",
    serverId: SERVER_1,
  });
  await db
    .update(destTable)
    .set({
      lastFreeBytes: 331_000_000_000,
      lastTotalBytes: 431_000_000_000,
      resolvedPath: "/var/lib/deplo/backups",
    })
    .where(eq(destTable.id, "dst_1"));

  await asUser1(async () => {
    await testDestinations();
    const [d] = await listDestinations();
    assert.equal(d.status, "error");
    assert.equal(d.lastFreeBytes, 331_000_000_000);
    assert.equal(d.lastTotalBytes, 431_000_000_000);
    assert.equal(d.resolvedPath, "/var/lib/deplo/backups");
  });
});
