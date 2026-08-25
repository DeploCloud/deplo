import "server-only";

// https://deplo.build/docs/guides/observability/logs

import { asc, eq } from "drizzle-orm";

import { stripAnsi } from "../ansi";
import { getDb } from "../db/client";
import { deploymentLogs } from "../db/schema/control-plane";
import { detectLogLevel } from "../log-level-detect";
import { assembleLogLine, logLineToRow } from "./app-graph-rows";
import type { LogLine } from "../types";

/**
 * Buffered writer for `deployment_logs` (relational-store PLAN §6 Decision 18).
 * Inserting per line would be a round-trip storm; a JSONB array would reintroduce
 * the whole-document write-amplification this migration kills.
 */

const FLUSH_MS = 250;
const MAX_BUFFER = 200;

/**
 * Backstop against unbounded growth while the DB flush keeps FAILING: the failed
 * batch stays at the buffer head for an in-order retry, but a persistent outage
 * under a verbose build would otherwise buffer the whole log forever.
 */
const MAX_RETAINED = 2_000;

/**
 * The bounds on what ONE deployment may persist, because the build's output is the
 * tenant's to write and `deployment_logs` lives in the CONTROL PLANE's database —
 * shared by every team, the rate limiter and every session.
 */
let MAX_LINE_CHARS = 4_000;
let MAX_LINES_PER_DEPLOYMENT = 20_000;

/** Shrink the caps so the suite can prove them without writing 20k rows. */
export function __setLogCapsForTest(lines: number, chars: number): void {
  MAX_LINES_PER_DEPLOYMENT = lines;
  MAX_LINE_CHARS = chars;
}
export function __resetLogCapsForTest(): void {
  MAX_LINES_PER_DEPLOYMENT = 20_000;
  MAX_LINE_CHARS = 4_000;
}
/**
 * How many deployments' budgets to remember.
 */
const MAX_TRACKED_BUDGETS = 5_000;

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
  /**
   * Lines ENQUEUED per deployment since its last clear — the budget the
   * per-deployment ceiling spends. A counter living there would reset on every
   * such read and the ceiling would be bypassable at will.
   */
  enqueued: Map<string, number>;
}

const LOGS_KEY = Symbol.for("deplo.deployment-logs.buffers");
const g = globalThis as unknown as { [LOGS_KEY]?: LogState };
function state(): LogState {
  return (g[LOGS_KEY] ??= { buffers: new Map(), enqueued: new Map() });
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
 * Enqueue one log line for a deployment (SYNCHRONOUS, fire-and-forget). Never
 * throws into the caller — a flush failure is swallowed (logs are best-effort; the
 * deploy must not fail because a log line couldn't persist).
 */
export function appendLog(depId: string, line: LogLine): void {
  const b = bufferFor(depId);
  // Bound what one deployment may persist into the SHARED control-plane database
  // (see MAX_LINE_CHARS / MAX_LINES_PER_DEPLOYMENT). Silent by design past the
  // ceiling: one marker line, then nothing — a log line must never fail a deploy.
  const s = state();
  if (s.enqueued.size > MAX_TRACKED_BUDGETS && !s.enqueued.has(depId)) {
    // Drop the oldest fifth in one pass, so this runs rarely rather than per line.
    let drop = Math.floor(MAX_TRACKED_BUDGETS / 5);
    for (const k of s.enqueued.keys()) {
      if (drop-- <= 0) break;
      s.enqueued.delete(k);
    }
  }
  const seen = (s.enqueued.get(depId) ?? 0) + 1;
  if (seen > MAX_LINES_PER_DEPLOYMENT) return;
  s.enqueued.set(depId, seen);
  if (seen === MAX_LINES_PER_DEPLOYMENT) {
    b.lines.push({
      ts: line.ts,
      level: "info",
      text: `[deplo] log truncated at ${MAX_LINES_PER_DEPLOYMENT} lines — the rest of this build's output is not stored`,
    });
  } else {
    b.lines.push(
      line.text.length > MAX_LINE_CHARS
        ? {
            ...line,
            text: `${line.text.slice(0, MAX_LINE_CHARS)}… [deplo] line truncated`,
          }
        : line,
    );
  }
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
  // Capture the epoch so a clear that fires before this flush commits drops it. The
  // chain serializes per deployment, so two flush callbacks never read the buffer
  // concurrently.
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
      // Remove exactly the lines we wrote (the head), leaving any appended while the
      // insert was in flight for the next flush. Re-check the epoch: a clear that landed
      // mid-insert already emptied the buffer, so removing here would drop fresh lines.
      if (bufferFor(depId).epoch === epochAtDrain) {
        bufferFor(depId).lines.splice(0, batch.length);
      }
    } catch (err) {
      // Best-effort: a failed flush must not crash the deploy. The lines stay at
      // the buffer head (we never removed them), so a later flush retries them IN
      // ORDER. Nothing to re-queue.
      console.error(`[deplo] deployment_logs flush failed for ${depId}:`, err);
      // ...but cap what a flush OUTAGE may retain (epoch-checked: a clear that
      // landed mid-insert already emptied the buffer, and fresh post-clear lines
      // are not ours to drop).
      const cur = bufferFor(depId);
      if (cur.epoch === epochAtDrain && cur.lines.length > MAX_RETAINED) {
        cur.lines.splice(0, cur.lines.length - MAX_RETAINED);
      }
    }
  });
  void immediate;
  return b.chain;
}

/**
 * Drop a deployment's buffer entry once it holds nothing — the missing half of the
 * Map's lifecycle (the same deletion-forgets shape as container-history's prune;
 * activity re-creates).
 */
function evictIfIdle(depId: string): void {
  const s = state();
  const b = s.buffers.get(depId);
  if (b && b.lines.length === 0 && b.timer === null) s.buffers.delete(depId);
}

/**
 * Flush any buffered lines for a deployment and AWAIT the write — the guaranteed
 * final flush on deploy end/error. After it resolves the buffer is empty and its
 * chain settled, so a reader sees every enqueued line.
 */
export async function finalizeDeploymentLogs(depId: string): Promise<void> {
  await scheduleFlush(depId, true);
  await bufferFor(depId).chain;
  evictIfIdle(depId);
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
  state().enqueued.delete(depId);
  b.epoch++;
  // Wait for the prior chain to settle (it self-drops on the epoch mismatch),
  // then DELETE the persisted rows.
  await b.chain;
  await getDb()
    .delete(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, depId));
  evictIfIdle(depId);
}

/**
 * `info` on a build line means "nobody said" — so read it, exactly like a runtime
 * line. A level the producer did state is never second-guessed, and a line the
 * detector can't place stays `info`.
 */
function classifyUnstated(line: LogLine): LogLine {
  if (line.level !== "info") return line;
  const level = detectLogLevel(stripAnsi(line.text));
  return level === "info" ? line : { ...line, level };
}

/**
 * Read a deployment's logs in order. Flushes any pending buffer first so an
 * in-progress build's just-emitted lines are included, then SELECTs by the `id`
 * identity (reproduces enqueue/Array.push order).
 */
export async function loadDeploymentLogs(depId: string): Promise<LogLine[]> {
  await finalizeDeploymentLogs(depId);
  const rows = await getDb()
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, depId))
    .orderBy(asc(deploymentLogs.id));
  return rows.map((row) => classifyUnstated(assembleLogLine(row)));
}

/** Test-only: clear all in-memory buffers (so cases don't leak timers/chains). */
export function __resetDeploymentLogBuffers(): void {
  const s = state();
  for (const b of s.buffers.values()) if (b.timer) clearTimeout(b.timer);
  s.buffers.clear();
}
