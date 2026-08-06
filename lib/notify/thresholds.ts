import "server-only";

import { dispatchServerAlert } from "./dispatch";
import type { ServerMetrics } from "../data/monitoring";

/**
 * "This server is about to stop working" — the one thing the metrics stream knew
 * and never told anybody.
 *
 * Runs on every frame (once per host per 5s), so the steady state has to be free:
 * a `Map.get` per metric, no query, no allocation that matters. The dispatcher's
 * own dedupe then absorbs everything that isn't a transition.
 *
 * Three guards against crying wolf, in order:
 *  - a SUSTAIN window, so a compile spike or a `docker pull` is not an alert;
 *  - a CLEAR band below the limit, so 89 ↔ 91 cannot flap;
 *  - the cooldown in `cooldown.ts`, so a genuinely full disk nags hourly, not
 *    every five seconds.
 *
 * Deliberately NOT configurable. Opinionated defaults are the first-run rule, and
 * 90% is where a box stops behaving; the constants are exported so an eventual
 * Advanced panel has something to read instead of a second source of truth.
 */

/** Percent at which a metric counts as "in trouble". */
export const LIMIT_PCT = { cpu: 90, mem: 90, disk: 90 } as const;
/** Percent it must fall back under before the condition is considered over. */
export const CLEAR_PCT = 85;
/** How long it must stay above the limit before anybody is told. */
export const SUSTAIN_MS = 5 * 60_000;

type Metric = "cpu" | "mem" | "disk";

/** Since when this metric has been over the limit, and whether we said so. */
interface High {
  since: number;
  alerted: boolean;
}

const KEY = Symbol.for("deplo.notify.thresholds");
const highSince = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<
  string,
  High
>()) as Map<string, High>;

const READ: Record<Metric, (m: ServerMetrics) => number> = {
  cpu: (m) => m.cpu,
  mem: (m) => m.memPct,
  disk: (m) => m.diskPct,
};

export function checkResourceThresholds(
  serverId: string,
  serverName: string,
  m: ServerMetrics,
  now: number = Date.now(),
): void {
  for (const alert of evaluateThresholds(serverId, serverName, m, now))
    dispatchServerAlert(serverId, alert);
}

/** What a snapshot decides, before anything is sent. Pure enough to unit-test. */
export interface ThresholdAlert {
  key: "server_disk_low" | "server_resources_high";
  dedupe: { id: string; state: "high" | "ok" };
  title: string;
  body: string;
  path: string;
}

export function evaluateThresholds(
  serverId: string,
  serverName: string,
  m: ServerMetrics,
  now: number = Date.now(),
): ThresholdAlert[] {
  const out: ThresholdAlert[] = [];
  for (const metric of ["cpu", "mem", "disk"] as const) {
    const value = READ[metric](m);
    if (!Number.isFinite(value)) continue;
    const slot = `${serverId}:${metric}`;

    const key =
      metric === "disk"
        ? ("server_disk_low" as const)
        : ("server_resources_high" as const);

    if (value >= LIMIT_PCT[metric]) {
      const high = highSince.get(slot);
      if (!high) {
        highSince.set(slot, { since: now, alerted: false });
        continue;
      }
      if (now - high.since < SUSTAIN_MS) continue;
      high.alerted = true;
      out.push({
        key,
        dedupe: { id: slot, state: "high" },
        title: `${serverName}: ${LABEL[metric]} at ${Math.round(value)}%`,
        body: body(metric, m),
        path: "/monitoring",
      });
    } else if (value < CLEAR_PCT) {
      // Only announce a recovery from something that was actually announced —
      // otherwise every healthy server says "back to normal" on its first frame.
      const wasAlerted = highSince.get(slot)?.alerted === true;
      highSince.delete(slot);
      if (wasAlerted)
        out.push({
          key,
          dedupe: { id: slot, state: "ok" },
          title: `${serverName}: ${LABEL[metric]} back to normal`,
          body: `Now at ${Math.round(value)}%.`,
          path: "/monitoring",
        });
    }
  }
  return out;
}

const LABEL: Record<Metric, string> = {
  cpu: "CPU",
  mem: "memory",
  disk: "disk",
};

function body(metric: Metric, m: ServerMetrics): string {
  if (metric === "disk")
    return `${gb(m.diskUsed)} of ${gb(m.diskTotal)} used. Deploys start failing when it fills.`;
  return `Above ${LIMIT_PCT[metric]}% for the last five minutes.`;
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Test hook — the sustain map outlives a single test file otherwise. */
export function __resetThresholds(): void {
  highSince.clear();
}
