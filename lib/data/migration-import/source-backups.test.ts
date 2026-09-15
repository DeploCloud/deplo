import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { SERVER_1 } from "../app-graph-test-helpers";
import { beginMigration } from "./run-lifecycle";
import {
  URL_BASE,
  source,
  asOwner,
  importProject,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

test("an application's volume backup comes across as an app backup on that destination", async () => {
  source.fixtures["destination.all"] = [
    {
      destinationId: "dst-1",
      name: "nightly",
      endpoint: "https://s3.acme.test",
      bucket: "backups",
      region: "eu-west-1",
      accessKey: "AK",
      secretAccessKey: "SK",
    },
  ];
  source.fixtures["volumeBackups.list"] = [
    {
      volumeName: "uploads",
      cronExpression: "0 4 * * *",
      enabled: true,
      keepLatestCount: 3,
      destinationId: "dst-1",
    },
    {
      volumeName: "cache",
      cronExpression: "0 4 * * *",
      enabled: true,
      destinationId: "dst-1",
    },
    {
      volumeName: "old",
      cronExpression: "0 6 * * *",
      enabled: false,
      destinationId: "dst-1",
    },
  ];
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({ agentPort: 9443, agentCertFingerprint: "ab".repeat(32) })
    .where(eq(serversTable.id, SERVER_1));
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const rows = await db.execute(
    "select b.schedule, b.retention_count, b.target_kind, d.name as dest from backups b join backup_destination d on d.id = b.destination_id where b.app_id is not null",
  );
  const notes = (await db.select().from(itemsTable))
    .filter((i) => i.runId === runId && i.sourceKind === "application")
    .map((i) => i.message ?? "");
  assert.ok(rows.rows.length >= 1, notes.join("\n"));
  for (const r of rows.rows)
    assert.deepEqual(
      {
        schedule: r.schedule,
        retention_count: r.retention_count,
        target_kind: r.target_kind,
        dest: r.dest,
      },
      {
        schedule: "0 4 * * *",
        retention_count: 3,
        target_kind: "app",
        dest: "nightly",
      },
    );
  assert.ok(
    notes.some((m) => /schedule came across: 0 4 \* \* \* to nightly/.test(m)),
    notes.join("\n"),
  );
  assert.ok(
    notes.some((m) =>
      /volume uploads, volume cache shared the schedule/.test(m),
    ),
    notes.join("\n"),
  );
  delete source.fixtures["volumeBackups.list"];
});

test("a database's backup schedule comes across onto the destination that came with it", async () => {
  source.fixtures["destination.all"] = [
    {
      destinationId: "dst-1",
      name: "nightly",
      endpoint: "https://s3.acme.test",
      bucket: "backups",
      region: "eu-west-1",
      accessKey: "AK",
      secretAccessKey: "SK",
    },
  ];
  (source.fixtures["postgres.one"] as { backups?: unknown[] }).backups = [
    {
      schedule: "0 3 * * *",
      enabled: true,
      keepLatestCount: 5,
      destination: { name: "nightly" },
    },
    {
      schedule: "0 4 * * *",
      enabled: true,
      destination: { name: "elsewhere" },
    },
    { schedule: "0 5 * * *", enabled: false, destination: { name: "nightly" } },
  ];
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({ agentPort: 9443, agentCertFingerprint: "ab".repeat(32) })
    .where(eq(serversTable.id, SERVER_1));
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const rows = await db.execute(
    "select b.schedule, b.retention_count, d.name as dest from backups b join backup_destination d on d.id = b.destination_id",
  );
  const notes = (await db.select().from(itemsTable))
    .filter((i) => i.runId === runId && i.sourceKind === "postgres")
    .map((i) => i.message ?? "");
  const dests = (await db.select().from(itemsTable))
    .filter((i) => i.runId === runId && i.sourceKind === "destination")
    .map((i) => `${i.outcome}: ${i.message ?? ""}`);
  assert.deepEqual(
    rows.rows,
    [{ schedule: "0 3 * * *", retention_count: 5, dest: "nightly" }],
    notes.join("\n") + "\nDEST " + dests.join("\n"),
  );
  assert.ok(
    notes.some((m) => /schedule came across: 0 3 \* \* \* to nightly/.test(m)),
    notes.join("\n"),
  );
  assert.ok(
    notes.some((m) => /0 4 \* \* \* to elsewhere.*not here/.test(m)),
    notes.join("\n"),
  );
});

test("a second pass lands the schedule the first pass had no destination for", async () => {
  (source.fixtures["postgres.one"] as { backups?: unknown[] }).backups = [
    {
      schedule: "0 3 * * *",
      enabled: true,
      keepLatestCount: 5,
      destination: { name: "nightly" },
    },
  ];
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({ agentPort: 9443, agentCertFingerprint: "ab".repeat(32) })
    .where(eq(serversTable.id, SERVER_1));
  const count = async () =>
    (await db.execute("select count(*)::int as n from backups")).rows[0]!.n;
  source.fixtures["destination.all"] = [];
  const first = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(first, "dok-prj-blink");
  assert.equal(await count(), 0);
  source.fixtures["destination.all"] = [
    {
      destinationId: "dst-1",
      name: "nightly",
      endpoint: "https://s3.acme.test",
      bucket: "backups",
      region: "eu-west-1",
      accessKey: "AK",
      secretAccessKey: "SK",
    },
  ];
  const second = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(second, "dok-prj-blink");
  const rows = await db.execute(
    "select b.schedule, b.retention_count, d.name as dest from backups b join backup_destination d on d.id = b.destination_id",
  );
  assert.deepEqual(rows.rows, [
    { schedule: "0 3 * * *", retention_count: 5, dest: "nightly" },
  ]);
  const skipped = (await db.select().from(itemsTable)).find(
    (i) => i.runId === second && i.sourceKind === "postgres",
  );
  assert.equal(skipped?.outcome, "skipped");
  assert.match(
    skipped?.message ?? "",
    /already in this environment.*schedule came across: 0 3 \* \* \* to nightly/,
  );
  const third = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(third, "dok-prj-blink");
  assert.equal(await count(), 1);
});
