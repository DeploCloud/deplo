import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { undoMigration, stopMigration } from "./revert";
import { beginMigration, finishMigration } from "./run-lifecycle";
import { getMigrationRun } from "./run-queries";
import { appendRunItem } from "./run-report";
import {
  abandonMigration,
  drainMigrationSourceUninstalls,
} from "./source-agents";
import { getServerById } from "../servers/roster";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import {
  URL_BASE,
  asOwner,
  importProject,
  seedSource,
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

function refusingAgent() {
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({ capabilities: ["self-update"] }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
      >,
  );
}

async function uninstallState(id: string) {
  const rows = await db.execute(
    `select uninstall_attempts, uninstall_error, uninstall_next_at from servers where id = '${id}'`,
  );
  return rows.rows[0] as {
    uninstall_attempts: number;
    uninstall_error: string;
    uninstall_next_at: string | null;
  };
}

test("finishing an import takes Deplo's agent back off the migration source", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.70");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));

  await asOwner(() => finishMigration(runId));

  assert.equal(
    await asOwner(() => getServerById(id)),
    null,
    "the source outlived the migration - someone has to go and remove it by hand",
  );
});

test("a run with more teams behind it leaves the agent where it is", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.80");
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, keepSources: true }),
  );

  await asOwner(() => finishMigration(runId));

  assert.ok(
    await asOwner(() => getServerById(id)),
    "the next team of that panel has no way back to the disks",
  );
  const [row] = await db
    .select({ next: serversTable.uninstallNextAt })
    .from(serversTable)
    .where(eq(serversTable.id, id));
  assert.equal(
    row?.next ?? null,
    null,
    "an uninstall is queued, so the machine will not follow the next team",
  );
});

test("data that did not copy KEEPS the source, agent and all", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.71");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / api",
    sourceKind: "volume",
    sourceName: "api-data",
    outcome: "failed",
    message: "the copy failed",
  });

  await asOwner(() => finishMigration(runId));

  assert.ok(
    await asOwner(() => getServerById(id)),
    "the only way back to the bytes was uninstalled",
  );
  const full = await asOwner(() => getMigrationRun(runId));
  assert.match(
    full!.items.find((i) => i.sourceKind === "server")!.message!,
    /still on dokploy-host: this migration left data that has not been copied/,
  );
});

test("a copy that was redone lets the agent go", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.74");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / web",
    sourceKind: "volume",
    sourceName: "web-data",
    outcome: "failed",
    targetKind: "app",
    targetId: web.id,
    message: "the copy failed",
  });
  await db.execute(
    `update apps set data_copy_error = '' where id = '${web.id}'`,
  );

  await asOwner(() => finishMigration(runId));

  assert.equal(
    await asOwner(() => getServerById(id)),
    null,
    "nothing is stranded any more, so the agent has no reason to stay",
  );
});

test("a host that will not let go is retried later, and says nothing yet", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.72", true);
  refusingAgent();
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));

  await asOwner(() => finishMigration(runId));

  assert.ok(await asOwner(() => getServerById(id)), "the row must survive");
  const state = await uninstallState(id);
  assert.equal(Number(state.uninstall_attempts), 1);
  assert.ok(state.uninstall_next_at, "a failed attempt schedules the next one");
  assert.equal(state.uninstall_error, "");
  const full = await asOwner(() => getMigrationRun(runId));
  assert.equal(
    full!.items.some((i) => i.sourceKind === "server"),
    false,
    "the report must not report a failure that is still being retried",
  );
});

test("after the third try Deplo gives up, and only then asks a person", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.73", true);
  refusingAgent();
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() => finishMigration(runId));

  const later = new Date(Date.now() + 10 * 60_000);
  await drainMigrationSourceUninstalls(later);
  assert.equal(Number((await uninstallState(id)).uninstall_attempts), 2);
  await drainMigrationSourceUninstalls(new Date(later.getTime() + 10 * 60_000));

  const state = await uninstallState(id);
  assert.equal(Number(state.uninstall_attempts), 3);
  assert.equal(state.uninstall_next_at, null, "it stopped trying");
  assert.match(String(state.uninstall_error), /too old to uninstall itself/);
  assert.ok(await asOwner(() => getServerById(id)), "the row must survive");
  const full = await asOwner(() => getMigrationRun(runId));
  assert.match(
    full!.items.find((i) => i.sourceKind === "server")!.message!,
    /could not remove its own agent from dokploy-host after 3 tries/,
  );
  const trail = await db.execute(
    "select message from activities where message like '%Could not remove Deplo%'",
  );
  assert.equal(trail.rows.length, 1);
});

test("a source that is not due yet is left alone by the sweep", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.74", true);
  refusingAgent();
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() => finishMigration(runId));

  await drainMigrationSourceUninstalls(new Date());
  assert.equal(Number((await uninstallState(id)).uninstall_attempts), 1);
});

test("the sweep finishes what a dead process started, with nobody signed in", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.75");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await db.execute(
    `update servers set uninstall_run_id = '${runId}', uninstall_next_at = now() - interval '1 minute' where id = '${id}'`,
  );

  await drainMigrationSourceUninstalls(new Date());

  assert.equal(
    await asOwner(() => getServerById(id)),
    null,
    "the sweep must be able to finish the job on its own",
  );
});

test("leaving the wizard pencils the source in, and the sweep takes it later", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.76");

  assert.equal(await asOwner(() => abandonMigration()), 1);

  assert.ok(await asOwner(() => getServerById(id)));
  const pencilled = await uninstallState(id);
  assert.equal(Number(pencilled.uninstall_attempts), 0);
  assert.ok(Date.parse(String(pencilled.uninstall_next_at)) > Date.now());
  await drainMigrationSourceUninstalls(new Date());
  assert.ok(await asOwner(() => getServerById(id)), "not due yet");

  await drainMigrationSourceUninstalls(new Date(Date.now() + 11 * 60_000));

  assert.equal(
    await asOwner(() => getServerById(id)),
    null,
    "walking away left an agent running on somebody else's machine",
  );
});

test("the sweep leaves a machine whose team has started a run since", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.82");
  await db.execute(
    `update servers set uninstall_next_at = now() - interval '1 minute' where id = '${id}'`,
  );
  await asOwner(() => beginMigration({ url: URL_BASE }));

  await drainMigrationSourceUninstalls(new Date());

  assert.ok(
    await asOwner(() => getServerById(id)),
    "the run reads its volumes through that agent",
  );
  assert.equal((await uninstallState(id)).uninstall_next_at, null);
});

test("leaving does not touch the sources a run in flight is reading", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.77");
  await asOwner(() => beginMigration({ url: URL_BASE }));

  assert.equal(await asOwner(() => abandonMigration()), 0);

  assert.ok(await asOwner(() => getServerById(id)));
});

test("leaving keeps the source that still holds data nothing could copy", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.78");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / api",
    sourceKind: "volume",
    sourceName: "api-data",
    outcome: "failed",
    message: "the copy failed",
  });
  await asOwner(() => finishMigration(runId));

  assert.equal(await asOwner(() => abandonMigration()), 0);

  assert.ok(
    await asOwner(() => getServerById(id)),
    "the only way back to the bytes was uninstalled",
  );
});

test("the revert after a failure keeps the agent the retry needs", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.81");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / api",
    sourceKind: "volume",
    sourceName: "api-data",
    outcome: "failed",
    message: "the copy failed",
  });

  await asOwner(() => undoMigration(runId, { forceSourceRemoval: false }));

  const [source] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, id));
  assert.ok(
    source,
    "the bytes are still over there and this is the way to them",
  );
  assert.equal(source.uninstallNextAt, null, "and nothing is taking it off");
});

test("a stopped run has already handed its sources back", async () => {
  const id = await seedSource(db, "dokploy-host", "192.0.2.79");
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() => stopMigration(runId));

  assert.equal(await asOwner(() => abandonMigration()), 0);
  const [source] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, id));
  assert.ok(
    !source || source.uninstallNextAt !== null || source.uninstallError,
    "stopping must put the source's agent on its way off, not leave it running",
  );
});
