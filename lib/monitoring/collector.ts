import "server-only";

import { listAllServers } from "../data/servers";
import {
  measureServerForCollector,
} from "../data/monitoring";
import { isMetricsSavingEnabled } from "../data/monitoring-settings";
import { resolveExpectedAgentVersion } from "../version";
import {
  latestSampleTs,
  pruneMetricsHistoryTo,
  recordMetricsSample,
} from "./history";

/**
 * The background metrics collector — what makes "save metrics on server" true even
 * when nobody has the Monitoring page open. Every {@link TICK_MS} it samples each
 * provisioned server whose history buffer has gone stale and records the result
 * into lib/monitoring/history.ts. A server someone IS watching needs nothing from
 * it: the dashboard's 1s poll already writes the buffer, so the freshness check
 * skips that host and the collector costs nothing extra.
 *
 * Started once per server boot from `instrumentation.ts` (Node runtime only), the
 * cleanup-scheduler shape — but deliberately WITHOUT its cross-process lease: the
 * buffer is per-process RAM, so in a horizontally-scaled deploy every instance
 * must keep its own copy warm; a lease would leave N−1 instances answering the
 * history query with nothing.
 *
 * Singleton on `globalThis` via `Symbol.for(...)`: Next compiles separate module
 * graphs, and `register()` could import this through more than one, so a
 * module-level flag would start two intervals.
 */

/** Background sampling cadence. 5s keeps an unwatched server's charts honest
 *  (12 points/min) at a fifth of the dashboard-poll cost; watching the page
 *  still gets the full 1s density via the poll path. */
const TICK_MS = 5_000;

/**
 * A buffer younger than this is being fed by someone else (a viewer's 1s poll) —
 * skip the host. The margin matters on both sides: a viewer-fed buffer is at most
 * ~1.3s old at any tick (1s poll + measure latency), while the collector's OWN
 * last sample is ~3.8s old (the measure stamps `ts` ~1.2s after the tick that
 * started it) — so 3.5s cleanly skips the former and never aliases the collector
 * into sampling every other tick (which would halve the cadence to 10s).
 */
const FRESH_MS = 3_500;

interface CollectorState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** True while a tick is in flight, so a slow fleet never overlaps the next. */
  ticking: boolean;
}

const STATE_KEY = Symbol.for("deplo.monitoring.collector");
const g = globalThis as unknown as { [STATE_KEY]?: CollectorState };
const state: CollectorState = (g[STATE_KEY] ??= {
  started: false,
  timer: null,
  ticking: false,
});

/**
 * One collector tick: if saving is on, measure every provisioned server whose
 * buffer has gone stale, in parallel (the fleet poll's shape). Exported for tests;
 * never throws — an unreachable host degrades to an offline snapshot inside
 * `metricsFor`, which the buffer then refuses, leaving the honest gap.
 */
export async function runMetricsCollectorTick(now: number = Date.now()): Promise<void> {
  if (state.ticking) return; // the previous tick is still draining; skip this one.
  state.ticking = true;
  try {
    if (!(await isMetricsSavingEnabled())) return;

    const servers = await listAllServers();
    // Forget removed servers' windows now rather than at the next restart.
    pruneMetricsHistoryTo(new Set(servers.map((s) => s.id)));

    const due = servers.filter(
      (s) =>
        // No agent yet (still provisioning / never enrolled): nothing to dial.
        Boolean(s.agent?.certFingerprint) &&
        now - latestSampleTs(s.id) >= FRESH_MS,
    );
    if (due.length === 0) return;

    const expected = await resolveExpectedAgentVersion();
    await Promise.all(
      due.map(async (s) => {
        try {
          recordMetricsSample(await measureServerForCollector(s, expected));
        } catch (e) {
          // metricsFor already contains transport failures; belt-and-braces so one
          // host can never take the whole tick down.
          console.warn(
            `[monitoring] collector sample of ${s.name} errored: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
  } catch (e) {
    console.warn(
      `[monitoring] metrics collector tick failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    state.ticking = false;
  }
}

/**
 * Start the collector loop. Idempotent — a second call is a no-op, so importing
 * this through more than one Next module graph can't start two loops. Called from
 * `instrumentation.ts` at boot (Node runtime only).
 */
export function startMetricsCollector(): void {
  if (state.started) return;
  state.started = true;
  // `unref()` so the interval never keeps the process alive on its own.
  const timer = setInterval(() => {
    void runMetricsCollectorTick();
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
  // Kick an immediate tick so a fresh boot starts accumulating history right away
  // instead of showing an empty chart for the first monitor visit.
  void runMetricsCollectorTick();
  console.log("[deplo] metrics collector started");
}

/** Test-only: stop the loop and reset the per-process state. */
export function __stopMetricsCollector(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.ticking = false;
}
