import "server-only";

import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  deployments as deploymentsTable,
} from "../db/schema/control-plane";
import { publishAppChanged } from "../graphql/pubsub";
import { nowIso } from "../ids";
import type { ContainerStat as PbContainerStat } from "../agent/gen/agent";
import type { Deployment } from "../types";

/**
 * Correct a stale `apps.status` from what the host is actually reporting.
 *
 * `apps.status` is INTENT: every one of its writers is a control-plane action
 * (create, deploy, start, stop), so the column is only ever as true as the last
 * action was — and one direction of it goes stale silently. A deploy that fails
 * while the PREVIOUS stack keeps serving writes `error`, and nothing revisits it.
 * That is not hypothetical: on 2026-07-19 a host rebooted, a user pressed Redeploy
 * nine times into the outage, each attempt failed its agent pre-flight and wrote
 * `error` — and when the host came back and Docker restarted the containers, the
 * App kept a red "Error" badge sitting directly above its own live, moving CPU
 * charts. 38 of 71 Apps were wearing that badge. Only a human clicking Redeploy or
 * Stop→Start could clear it.
 *
 * The telemetry stream already carries the refutation on every frame, every 5s
 * (`ContainerStat.state`, keyed by the `deplo.project` label). This is the
 * consumer for it.
 *
 * ## Why this WRITES the row instead of folding at render time
 *
 * `displayStatus` (lib/apps/display-status.ts) already folds stored status with a
 * live runtime probe — but only DOWNWARD, and deliberately: it short-circuits on
 * `status !== "active"` because "a failed deploy already says so". So the demotion
 * direction is live and needs no write, while the promotion direction is
 * structurally impossible there. Fixing it at the render layer instead would mean
 * (a) un-gating the per-App runtime probe, which is one agent dial per App per
 * viewer — the exact cost model the telemetry stream exists to remove — and
 * (b) teaching every OTHER reader to apply the same fold: the Overview grid reads
 * `apps.status` raw with no subscription and no probe at all, and so does every
 * external GraphQL client. The row is what is wrong; correct the row, and
 * `publishAppChanged` pushes it to the live badge for free.
 *
 * ## Why PROMOTION ONLY
 *
 * `error -> active` is the direction nothing else can do, and the direction that
 * cannot invent a red badge that was not there. Demotion (`active -> down` /
 * `restarting` / `degraded`) is already handled live by `displayStatus`, needs
 * hysteresis to tell a crash loop from a container swap, and is not what the
 * incident was. This module writes exactly one transition.
 */

/** Deployment states that mean a build owns this App's status right now. */
const IN_PROGRESS: Deployment["status"][] = ["queued", "building"];

/**
 * Does this App's telemetry prove it is up?
 *
 * Pure, and exported for the tests. Three deliberate refusals:
 *
 *  - an EMPTY bucket is not an answer. It cannot occur through
 *    {@link reconcileAppStatusFromTelemetry} (a bucket only exists because a
 *    container reported into it), but absence must never be readable as failure
 *    anywhere on this path.
 *  - a container `restarting` vetoes the whole App. A crash loop is not a working
 *    App, and `error` is a more honest word for it than `active` — promoting one
 *    would only hand it to `displayStatus` to re-demote to "restarting", flipping
 *    the badge through a state that was never true.
 *  - `state` is preferred over the legacy `running` boolean, but an agent too old
 *    to send `state` leaves it "" (proto3 default) rather than lying, so fall back
 *    to `running` there. Keying strictly on `state` would silently switch this
 *    whole feature off for part of a mixed-version fleet.
 */
export function telemetrySaysRunning(stats: readonly PbContainerStat[]): boolean {
  if (stats.length === 0) return false;
  if (stats.some((s) => s.state === "restarting")) return false;
  return stats.some((s) => (s.state ? s.state === "running" : s.running));
}

/**
 * Clear `error` off every App on `serverId` that this frame proves is running.
 * Returns the ids actually corrected (usually none). Never throws.
 *
 * UNGATED and team-agnostic, exactly like `markServerSeen` / `recordServerHealth`:
 * this runs in the telemetry stream loop, which has no request, no active team and
 * no user. The `serverId` guard below is what scopes it — Servers are the one
 * cross-team resource, and a host's own frame is authority over the Apps that host
 * is running, whoever owns them.
 *
 * ## The guards, and why each one exists
 *
 * All five live in the UPDATE's WHERE, not in a JS `if`. That is not style: five
 * of the eight writers of this column are UNCONDITIONAL, so a read-then-decide
 * would lose every race against a deploy landing in the gap. In the WHERE, a
 * racing deploy simply makes this statement match 0 rows.
 *
 *  1. `id IN (running)`  — only Apps this frame PROVES are running. An App absent
 *     from the frame is unknown, not failed (host down, agent restarting,
 *     container not created yet) and is never written from absence. This is also
 *     why the statement is skipped entirely on an empty list.
 *  2. `server_id = serverId` — the frame came from THIS host. An App moved to
 *     another server can still have containers on the old one (a failed teardown);
 *     the old host's telemetry must not claim the App is up where it no longer lives.
 *  3. `status = 'error'`  — the allowlist, and it is exactly one value:
 *       - `queued` / `building` are owned by the deploy pipeline and telemetry
 *         CANNOT contradict them: the previous container runs for the whole build,
 *         so every frame reports `running` and this would flip the badge off
 *         "Building" seconds after the user pressed Deploy.
 *       - `stopping` is written BEFORE an up-to-60s `docker stop`, so frames in
 *         that window still say `running` — promoting would make the user's Stop
 *         visibly bounce. `reconcileStatus` in lib/data/apps.ts already owns that
 *         self-heal; a second healer is a write-war by construction.
 *       - `idle` is the deliberate-stop case and the highest-stakes one: the
 *         containers are SUPPOSED to be gone, so if `restart: unless-stopped`
 *         brings one back, "running" is the failure and `idle` is the truth. It is
 *         the one status where telemetry cannot distinguish success from failure.
 *       - `active` needs no write.
 *  4. `migrate_from_server_id IS NULL` — a pending server move is not
 *     representable in `status`: the App has containers on the OLD host and a fresh
 *     stack on the NEW one, and this loop is per-server, so it would see two
 *     conflicting truths. The deploy that completes the move clears the marker.
 *  5. no `queued`/`building` deployment — the allowlist alone is not enough. The
 *     boot reconcile settles orphaned `building` deploys to `error` while
 *     deliberately leaving sibling `queued` rows for the deploy queue to re-drain
 *     (lib/deploy/build.ts), so `status='error'` AND a live queued deployment is a
 *     reachable state. Same guard `settleAppAfterCancel` uses, for the same reason.
 */
export async function reconcileAppStatusFromTelemetry(
  serverId: string,
  byProject: ReadonlyMap<string, readonly PbContainerStat[]>,
): Promise<string[]> {
  // Database ids ride the same `deplo.project` label; they simply match no row in
  // `apps` and drop out of the UPDATE, so they need no special case here.
  const running: string[] = [];
  for (const [id, stats] of byProject) {
    if (telemetrySaysRunning(stats)) running.push(id);
  }
  if (running.length === 0) return [];

  try {
    const corrected = await getDb()
      .update(appsTable)
      .set({ status: "active", updatedAt: nowIso() })
      .where(
        and(
          inArray(appsTable.id, running),
          eq(appsTable.serverId, serverId),
          eq(appsTable.status, "error"),
          isNull(appsTable.migrateFromServerId),
          notExists(
            getDb()
              .select({ one: sql`1` })
              .from(deploymentsTable)
              .where(
                and(
                  eq(deploymentsTable.appId, appsTable.id),
                  inArray(deploymentsTable.status, IN_PROGRESS),
                ),
              ),
          ),
        ),
      )
      .returning({ id: appsTable.id });

    // Publish only what actually changed. `.returning()` is the change signal —
    // the statement above is a no-op in the steady state (no App in `error`), and
    // an unconditional publish would put a full re-read plus an SSE frame on every
    // dashboard on the stream's cadence, for nothing.
    for (const row of corrected) publishAppChanged(row.id);
    if (corrected.length > 0) {
      console.log(
        `[deplo] telemetry cleared a stale "error" on ${corrected.length} app(s): ` +
          corrected.map((r) => r.id).join(", "),
      );
    }
    return corrected.map((r) => r.id);
  } catch (e) {
    // Best-effort, like markServerSeen: a DB blip must never take down the
    // telemetry stream that called us.
    console.error("[deplo] reconcileAppStatusFromTelemetry failed:", e);
    return [];
  }
}
