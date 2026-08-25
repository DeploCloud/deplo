import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-runner-"));

import { makeTestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  acquireLease,
  LEASE_STALE_MS,
  __resetLocalLeases,
} from "../backups/lease";
import {
  leaseFor,
  releaseMigrationRunnerLease,
  runMigrationTick,
} from "./dokploy-runner";

/**
 * The runner's lease, which decides whether a migration may move.
 *
 * It went missing from the shutdown list when the runner was added, and its
 * staleness was the schedulers' two hours - so a control plane killed during an
 * import left the migration frozen until the window aged out, with nothing on
 * screen saying so.
 *
 * And it was ONE lease for the whole instance, which is the bug this file mostly
 * exists for now: renewed on every beat of whatever run was being driven, it was
 * held for as long as that run took - an hour, on a 15 GB volume - so a
 * migration somebody started meanwhile sat at "Migration in progress" with no
 * runner, no heartbeat and not one line of log. Per RUN, it means the only thing
 * a lease ever meant: two processes must not drive the same one.
 */

let harness: Awaited<ReturnType<typeof makeTestDb>>;

before(async () => {
  harness = await makeTestDb();
  __setTestDb(harness.db);
});

after(async () => {
  __resetTestDb();
  await harness.pg.close();
});

beforeEach(async () => {
  __resetLocalLeases();
  await harness.db.execute("delete from dokploy_imports;");
});

/** A run the tick will pick up and drive. With no `actor_user_id` it fails on
 *  its first line, which is all this file needs: what matters is WHICH runs the
 *  tick reaches, not what it does when it gets there. */
async function seedRun(id: string): Promise<string> {
  await harness.db.execute(
    `insert into teams (id, name, slug, plan, created_at)
     values ('team_r', 'Runner', 'runner', 'free', now())
     on conflict (id) do nothing;`,
  );
  await harness.db.execute(
    `insert into dokploy_imports
       (id, team_id, source_url, actor, status, created, skipped, failed, manual,
        started_at, api_key_enc, total_steps, done_steps, phase)
     values ('${id}', 'team_r', 'https://dokploy.example', 'tester', 'running', 0, 0, 0, 0,
             now(), 'enc', 1, 0, 'config');`,
  );
  return id;
}

async function statusOf(id: string): Promise<string> {
  const r = await harness.db.execute(
    `select status from dokploy_imports where id = '${id}'`,
  );
  return String((r.rows[0] as { status: string }).status);
}

test("a run somebody else is driving does not stop the next one", async () => {
  const held = await seedRun("dimp_held");
  const fresh = await seedRun("dimp_fresh");
  // Another control plane has the first one, alive and beating.
  assert.equal(await acquireLease(leaseFor(held), "another-instance"), true);

  await runMigrationTick();

  assert.equal(
    await statusOf(held),
    "running",
    "a run another process holds must be left exactly where it is",
  );
  assert.notEqual(
    await statusOf(fresh),
    "running",
    "and it must not keep the tick from driving a DIFFERENT run - which is what one lease for the whole instance did",
  );
});

test("a run the tick finished leaves no lease behind", async () => {
  const id = await seedRun("dimp_done");
  await runMigrationTick();
  assert.equal(
    await acquireLease(leaseFor(id), "another-instance"),
    true,
    "a restart must hand a migration over on the next tick, not in two hours",
  );
  // And handing back on shutdown is a no-op when nothing is in flight.
  await releaseMigrationRunnerLease();
});

test("a runner that died is taken over in 90s, not in the schedulers' two hours", async () => {
  const id = await seedRun("dimp_dead");
  // The dead process never released it: the next control plane can only wait.
  assert.equal(await acquireLease(leaseFor(id), "dead-instance"), true);
  const ninetySeconds = new Date(Date.now() + 91_000);
  assert.equal(
    await acquireLease(leaseFor(id), "successor", ninetySeconds, 90_000),
    true,
  );
  assert.ok(
    LEASE_STALE_MS > 90_000,
    "the point of the shorter window is that it is shorter than the default",
  );
});
