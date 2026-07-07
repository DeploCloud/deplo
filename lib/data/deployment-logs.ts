import "server-only";

import { asc, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { deploymentLogs } from "../db/schema/control-plane";
import { assembleLogLine, logLineToRow } from "./service-graph-rows";
import type { LogLine } from "../types";

/**
 * Buffered writer for `deployment_logs` (relational-store PLAN §6 Decision 18).
 *
 * `build.ts`'s `log()` pushes ONE `LogLine` per call and a verbose docker build
 * emits thousands. Inserting per line would be a round-trip storm; a JSONB array
 * would reintroduce the whole-document write-amplification this migration kills.
 * So lines are enqueued into an in-memory per-deployment buffer (a SYNCHRONOUS,
 * fire-and-forget enqueue, so `log()` stays a `void` sink usable as a callback
 * prop), and flushed in the background as one multi-row `INSERT` per flush, on a
 * short timer or when the buffer fills.
 *
 * Guarantees:
 *  - **Serialized per `deployment_id`.** Each deployment's flush chains off its
 *    own promise, so two flushes for one deployment never interleave (and the
 *    DB-generated `id` reproduces enqueue order). Different deployments flush
 *    concurrently.
 *  - **Guaranteed final flush.** {@link finalizeDeploymentLogs} drains and awaits
 *    the buffer on deploy end/error; crash-loss is mitigated by
 *    `reconcileInFlightDeployments` marking orphaned deploys `error` at boot.
 *  - **Drain-then-DELETE can't be resurrected.** {@link clearDeploymentLogs}
 *    bumps a per-deployment EPOCH and deletes; a late flush carrying the old
 *    epoch is dropped, so a cleared deployment never gets stale lines re-inserted
 *    (PLAN §6 "a late flush can't resurrect cleared lines").
 *
 * Pinned on `globalThis` (the same RSC/route-handler module-registry split reason
 * as `client.ts`/`store.ts`) so one process has ONE buffer, not two.
 */

const FLUSH_MS = 250;
const MAX_BUFFER = 200;

interface DeploymentBuffer {
  lines: LogLine[];
  /** Bumped by clearDeploymentLogs; a flush captured under an old epoch is dropped. */
  epoch: number;
  /** Pending flush timer (null when idle). */
  timer: ReturnType<typeof setTimeout> | null;
  /** The tail of this deployment's serialized flush chain. */
  chain: Promise<void>;
}

interface LogState {
  buffers: Map<string, DeploymentBuffer>;
}

const LOGS_KEY = Symbol.for("deplo.deployment-logs.buffers");
const g = globalThis as unknown as { [LOGS_KEY]?: LogState };
function state(): LogState {
  return (g[LOGS_KEY] ??= { buffers: new Map() });
}

function bufferFor(depId: string): DeploymentBuffer {
  const s = state();
  let b = s.buffers.get(depId);
  if (!b) {
    b = { lines: [], epoch: 0, timer: null, chain: Promise.resolve() };
    s.buffers.set(depId, b);
  }
  return b;
}

/**
 * Enqueue one log line for a deployment (SYNCHRONOUS, fire-and-forget). Schedules
 * a background flush (or flushes immediately when the buffer is full). Never
 * throws into the caller — a flush failure is swallowed (logs are best-effort;
 * the deploy must not fail because a log line couldn't persist).
 */
export function appendLog(depId: string, line: LogLine): void {
  const b = bufferFor(depId);
  b.lines.push(line);
  if (b.lines.length >= MAX_BUFFER) {
    void scheduleFlush(depId, true);
  } else if (!b.timer) {
    b.timer = setTimeout(() => void scheduleFlush(depId, false), FLUSH_MS);
  }
}

/** Drain the buffer and chain a multi-row INSERT, serialized per deployment. */
function scheduleFlush(depId: string, immediate: boolean): Promise<void> {
  const b = bufferFor(depId);
  if (b.timer) {
    clearTimeout(b.timer);
    b.timer = null;
  }
  if (b.lines.length === 0) return b.chain;
  // Capture the epoch so a clear that fires before this flush commits drops it.
  // The lines are NOT drained synchronously — the chained callback reads the
  // buffer HEAD at run time and only REMOVES it on a successful insert. New lines
  // always append to the tail, so the head is always the oldest unflushed lines:
  // this preserves enqueue order even when a flush fails and a later flush
  // retries (a drain-and-unshift-on-failure would invert order across two failed
  // batches). The chain serializes per deployment, so two flush callbacks never
  // read the buffer concurrently.
  const epochAtDrain = b.epoch;
  b.chain = b.chain.then(async () => {
    const buf = bufferFor(depId);
    // Cleared after this flush was scheduled ⇒ discard (the clear already emptied
    // the buffer + DELETEd the rows; nothing to write).
    if (buf.epoch !== epochAtDrain) return;
    const batch = buf.lines.slice();
    if (batch.length === 0) return;
    try {
      await getDb()
        .insert(deploymentLogs)
        .values(batch.map((line) => logLineToRow(depId, line)));
      // Remove exactly the lines we wrote (the head), leaving any appended while
      // the insert was in flight for the next flush. Re-check the epoch: a clear
      // that landed mid-insert already emptied the buffer, so removing here would
      // drop fresh lines.
      if (bufferFor(depId).epoch === epochAtDrain) {
        bufferFor(depId).lines.splice(0, batch.length);
      }
    } catch (err) {
      // Best-effort: a failed flush must not crash the deploy. The lines stay at
      // the buffer head (we never removed them), so a later flush retries them IN
      // ORDER. Nothing to re-queue.
      console.error(`[deplo] deployment_logs flush failed for ${depId}:`, err);
    }
  });
  void immediate;
  return b.chain;
}

/**
 * Flush any buffered lines for a deployment and AWAIT the write — the guaranteed
 * final flush on deploy end/error. After it resolves the buffer is empty and its
 * chain settled, so a reader sees every enqueued line.
 */
export async function finalizeDeploymentLogs(depId: string): Promise<void> {
  await scheduleFlush(depId, true);
  await bufferFor(depId).chain;
}

/**
 * Drain-then-DELETE a deployment's logs (the `logs[depId] = []` clear that
 * starts a fresh build's stream). Bumps the epoch so any in-flight flush carrying
 * the old epoch is discarded — a late flush can't resurrect the cleared lines.
 */
export async function clearDeploymentLogs(depId: string): Promise<void> {
  const b = bufferFor(depId);
  if (b.timer) {
    clearTimeout(b.timer);
    b.timer = null;
  }
  // Drop any buffered-but-unflushed lines and invalidate in-flight flushes.
  b.lines = [];
  b.epoch++;
  // Wait for the prior chain to settle (it self-drops on the epoch mismatch),
  // then DELETE the persisted rows.
  await b.chain;
  await getDb().delete(deploymentLogs).where(eq(deploymentLogs.deploymentId, depId));
}

/**
 * Read a deployment's logs in order. Flushes any pending buffer first so an
 * in-progress build's just-emitted lines are included, then SELECTs by the
 * `id` identity (reproduces enqueue/Array.push order).
 */
export async function loadDeploymentLogs(depId: string): Promise<LogLine[]> {
  await finalizeDeploymentLogs(depId);
  const rows = await getDb()
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, depId))
    .orderBy(asc(deploymentLogs.id));
  return rows.map(assembleLogLine);
}

/** Test-only: clear all in-memory buffers (so cases don't leak timers/chains). */
export function __resetDeploymentLogBuffers(): void {
  const s = state();
  for (const b of s.buffers.values()) if (b.timer) clearTimeout(b.timer);
  s.buffers.clear();
}
