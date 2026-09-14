import "server-only";

// https://deplo.build/docs/guides/observability/logs

import { asc, eq } from "drizzle-orm";

import { stripAnsi } from "../ansi";
import { getDb } from "../db/client";
import { deploymentLogs } from "../db/schema/control-plane/deployments";
import { detectLogLevel } from "../log-level-detect";
import { assembleLogLine, logLineToRow } from "./app-graph-rows/deployment";
import type { LogLine } from "../types/deployment";

const FLUSH_MS = 250;
const MAX_BUFFER = 200;

// Backstop while the DB flush keeps FAILING: an outage must not buffer a whole build.
const MAX_RETAINED = 2_000;

// The bounds on what ONE deployment may persist into the SHARED control-plane database.
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
const MAX_TRACKED_BUDGETS = 5_000;

interface DeploymentBuffer {
  lines: LogLine[];
  /** Bumped by clearDeploymentLogs; a flush captured under an old epoch is dropped. */
  epoch: number;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
}

interface LogState {
  buffers: Map<string, DeploymentBuffer>;
  /** Lines ENQUEUED since the last clear: a counter in the buffer would reset and be bypassable. */
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

// Enqueue one log line for a deployment (SYNCHRONOUS, fire-and-forget). Never throws.
export function appendLog(depId: string, line: LogLine): void {
  const b = bufferFor(depId);
  // Silent past the ceiling: one marker line, then nothing - a log line must never fail a deploy.
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
      text: `[deplo] log truncated at ${MAX_LINES_PER_DEPLOYMENT} lines - the rest of this build's output is not stored`,
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

function scheduleFlush(depId: string, immediate: boolean): Promise<void> {
  const b = bufferFor(depId);
  if (b.timer) {
    clearTimeout(b.timer);
    b.timer = null;
  }
  if (b.lines.length === 0) return b.chain;
  // Capture the epoch so a clear that fires before this flush commits drops it.
  const epochAtDrain = b.epoch;
  b.chain = b.chain.then(async () => {
    const buf = bufferFor(depId);
    if (buf.epoch !== epochAtDrain) return;
    const batch = buf.lines.slice();
    if (batch.length === 0) return;
    try {
      await getDb()
        .insert(deploymentLogs)
        .values(batch.map((line) => logLineToRow(depId, line)));
      // Re-check the epoch: a clear mid-insert already emptied the buffer, so this would drop fresh lines.
      if (bufferFor(depId).epoch === epochAtDrain) {
        bufferFor(depId).lines.splice(0, batch.length);
      }
    } catch (err) {
      // The lines stay at the buffer head (never removed), so a later flush retries them
      // IN ORDER - nothing to re-queue.
      console.error(`[deplo] deployment_logs flush failed for ${depId}:`, err);
      // Cap what a flush OUTAGE may retain; fresh post-clear lines are not ours to drop.
      const cur = bufferFor(depId);
      if (cur.epoch === epochAtDrain && cur.lines.length > MAX_RETAINED) {
        cur.lines.splice(0, cur.lines.length - MAX_RETAINED);
      }
    }
  });
  void immediate;
  return b.chain;
}

function evictIfIdle(depId: string): void {
  const s = state();
  const b = s.buffers.get(depId);
  if (b && b.lines.length === 0 && b.timer === null) s.buffers.delete(depId);
}

// Flush any buffered lines for a deployment and AWAIT the write.
export async function finalizeDeploymentLogs(depId: string): Promise<void> {
  await scheduleFlush(depId, true);
  await bufferFor(depId).chain;
  evictIfIdle(depId);
}

// Drain-then-DELETE a deployment's logs, bumping the epoch so an in-flight flush is discarded.
export async function clearDeploymentLogs(depId: string): Promise<void> {
  const b = bufferFor(depId);
  if (b.timer) {
    clearTimeout(b.timer);
    b.timer = null;
  }
  b.lines = [];
  state().enqueued.delete(depId);
  b.epoch++;
  await b.chain;
  await getDb()
    .delete(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, depId));
  evictIfIdle(depId);
}

// `info` on a build line means "nobody said", so a level the producer stated is never second-guessed.
function classifyUnstated(line: LogLine): LogLine {
  if (line.level !== "info") return line;
  const level = detectLogLevel(stripAnsi(line.text));
  return level === "info" ? line : { ...line, level };
}

// Read a deployment's logs in order, flushing any pending buffer first.
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
