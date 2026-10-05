import "server-only";

import { and, eq, lte, type SQL } from "drizzle-orm";

import { getDb } from "../../db/client";
import { deploMovePauses } from "../../db/schema/control-plane/deplo-move";
import {
  PAUSE_LEASE_MS,
  type MovePauseResponse,
  type WorkloadRef,
} from "../../deplo-move/protocol";
import { nowIso } from "../../ids";
import { STACK_DEADLINE_MS } from "../../infra/agent-client/deadlines";
import { startStackOn, stopStackOn } from "../volume-migration";
import { MoveRefusedError } from "./source-row";

// The old Deplo lends each workload to a copy as a lease (ADR-0035): it starts again by itself once the lease lapses.

type PauseRow = typeof deploMovePauses.$inferSelect;

const TIMING = { renewMs: PAUSE_LEASE_MS / 4, sweepMs: 30_000 };
let timing = { ...TIMING };

export function __setPauseTimingForTest(t: Partial<typeof TIMING> = {}): void {
  timing = { ...TIMING, ...t };
}

const leaseFromNow = () => new Date(Date.now() + PAUSE_LEASE_MS).toISOString();

// A row being started again holds a lease no renewal reaches, so nothing else claims it; a crash lets it lapse.
const CLAIM_MS = STACK_DEADLINE_MS + 60_000;

function pauseOf(moveId: string, ref: WorkloadRef) {
  return and(
    eq(deploMovePauses.moveId, moveId),
    eq(deploMovePauses.kind, ref.kind),
    eq(deploMovePauses.workloadId, ref.id),
  );
}

const keyOf = (row: PauseRow) =>
  pauseOf(row.moveId, {
    kind: row.kind as WorkloadRef["kind"],
    id: row.workloadId,
  });

// No row means nothing to renew: never paused, already started again, or being started right now.
export async function renewLease(
  moveId: string,
  ref: WorkloadRef,
): Promise<MovePauseResponse | null> {
  const until = leaseFromNow();
  const [row] = await getDb()
    .update(deploMovePauses)
    .set({ leaseUntil: until })
    .where(and(pauseOf(moveId, ref), lte(deploMovePauses.leaseUntil, until)))
    .returning({
      leaseUntil: deploMovePauses.leaseUntil,
      wasRunning: deploMovePauses.wasRunning,
    });
  return row ?? null;
}

async function lapse(moveId: string, ref: WorkloadRef): Promise<void> {
  await getDb()
    .update(deploMovePauses)
    .set({ leaseUntil: nowIso() })
    .where(pauseOf(moveId, ref));
}

interface PauseTarget {
  ref: WorkloadRef;
  name: string;
  serverId: string;
  stack: string;
}

const startedAgain = (name: string) =>
  new MoveRefusedError(
    `${name} was started again while it was being paused. Try again.`,
    409,
  );

// The stop can outlast the lease: if the sweep started it meanwhile, it is started again rather than left stopped.
async function stopUnderLease(
  moveId: string,
  target: PauseTarget,
): Promise<MovePauseResponse> {
  try {
    await stopStackOn(target.serverId, target.stack);
  } catch (e) {
    // Whatever the stop left behind, the next sweep starts it again.
    await lapse(moveId, target.ref);
    throw e;
  }
  const renewed = await renewLease(moveId, target.ref);
  if (renewed) return renewed;
  try {
    await startStackOn(target.serverId, target.stack);
  } catch (e) {
    await getDb()
      .insert(deploMovePauses)
      .values({
        moveId,
        kind: target.ref.kind,
        workloadId: target.ref.id,
        serverId: target.serverId,
        stack: target.stack,
        wasRunning: true,
        leaseUntil: nowIso(),
      })
      .onConflictDoNothing()
      .catch((err) =>
        console.error(`[deplo-move] ${target.name} stays stopped:`, err),
      );
    throw e;
  }
  throw startedAgain(target.name);
}

// The row lands before the stop, so a crash right after the stop still leaves the sweep something to start.
export async function pauseWorkload(
  moveId: string,
  target: PauseTarget,
  isRunning: () => Promise<boolean>,
): Promise<MovePauseResponse> {
  const held = await renewLease(moveId, target.ref);
  if (held) {
    // Already lent: whatever started it since (a deploy, a restart) is stopped again before the copy reads on.
    if (!(await isRunning())) return held;
    if (!held.wasRunning)
      await getDb()
        .update(deploMovePauses)
        .set({ wasRunning: true })
        .where(pauseOf(moveId, target.ref));
    return stopUnderLease(moveId, target);
  }
  const wasRunning = await isRunning();
  const [row] = await getDb()
    .insert(deploMovePauses)
    .values({
      moveId,
      kind: target.ref.kind,
      workloadId: target.ref.id,
      serverId: target.serverId,
      stack: target.stack,
      wasRunning,
      leaseUntil: leaseFromNow(),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const raced = await renewLease(moveId, target.ref);
    if (raced) return raced;
    throw startedAgain(target.name);
  }
  if (!wasRunning) return { leaseUntil: row.leaseUntil, wasRunning };
  return stopUnderLease(moveId, target);
}

async function claim(where: SQL | undefined): Promise<PauseRow[]> {
  return getDb()
    .update(deploMovePauses)
    .set({ leaseUntil: new Date(Date.now() + CLAIM_MS).toISOString() })
    .where(where)
    .returning();
}

// Not claimed: a lease a renewal could still have set.
const unclaimed = () => lte(deploMovePauses.leaseUntil, leaseFromNow());

// The row stays until the stack is up, so a failed start (or a crash) always leaves the sweep something to retry.
async function restart(row: PauseRow): Promise<void> {
  const mine = and(keyOf(row), eq(deploMovePauses.leaseUntil, row.leaseUntil));
  if (row.wasRunning)
    try {
      await startStackOn(row.serverId, row.stack);
    } catch (e) {
      await getDb()
        .update(deploMovePauses)
        .set({ leaseUntil: nowIso() })
        .where(mine);
      throw e;
    }
  await getDb().delete(deploMovePauses).where(mine);
}

// False when there was no lease to give back: it lapsed (and the workload started again), or never existed.
export async function resumeWorkload(
  moveId: string,
  ref: WorkloadRef,
): Promise<boolean> {
  const [row] = await claim(and(pauseOf(moveId, ref), unclaimed()));
  if (!row) return false;
  await restart(row);
  return true;
}

// Every workload this move holds starts again now; one that will not start stays for the sweep.
export async function resumeAllPauses(moveId: string): Promise<void> {
  const rows = await claim(
    and(eq(deploMovePauses.moveId, moveId), unclaimed()),
  );
  const failed = await Promise.allSettled(rows.map(restart));
  for (const r of failed)
    if (r.status === "rejected")
      console.error("[deplo-move] a paused workload did not start:", r.reason);
}

export async function resumeLapsedPauses(): Promise<void> {
  const lapsed = await claim(lte(deploMovePauses.leaseUntil, nowIso()));
  const results = await Promise.allSettled(lapsed.map(restart));
  for (const r of results)
    if (r.status === "rejected")
      console.error(
        "[deplo-move] a workload whose lease lapsed did not start:",
        r.reason,
      );
}

// Renews while bytes flow or the agent works on the next chunk; a reader quiet for a whole lease lets it lapse.
export function holdingLease(
  moveId: string,
  ref: WorkloadRef,
  chunks: AsyncIterable<Buffer>,
): AsyncIterable<Buffer> {
  return (async function* () {
    const it = chunks[Symbol.asyncIterator]();
    let waiting = false;
    let since = Date.now();
    const timer = setInterval(() => {
      if (waiting && Date.now() - since > PAUSE_LEASE_MS) return;
      void renewLease(moveId, ref).catch(() => {});
    }, timing.renewMs);
    timer.unref?.();
    try {
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        waiting = true;
        since = Date.now();
        yield next.value;
        waiting = false;
      }
    } finally {
      clearInterval(timer);
      await it.return?.();
    }
  })();
}

const SWEEP = Symbol.for("deplo.move.pause-sweep");

// Runs on every Deplo, frozen or not: the old one's apps must never stay stopped because the new one died.
export function startPauseSweep(): void {
  const g = globalThis as unknown as { [SWEEP]?: boolean };
  if (g[SWEEP]) return;
  g[SWEEP] = true;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void resumeLapsedPauses()
      .catch((e) => console.error("[deplo-move] the pause sweep failed:", e))
      .finally(() => {
        running = false;
      });
  };
  setInterval(tick, timing.sweepMs).unref?.();
  setTimeout(tick, 5_000).unref?.();
}
