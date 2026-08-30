// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
import { reportAppHealth } from "../notify/apps";

/**
 * Correct a stale `apps.status` from what the host is actually reporting.
 */

/** Deployment states that mean a build owns this App's status right now. */
const IN_PROGRESS: Deployment["status"][] = ["queued", "building"];

/**
 * Does this App's telemetry prove it is up? Keying strictly on `state` would
 * silently switch this whole feature off for part of a mixed-version fleet.
 */
export function telemetrySaysRunning(
  stats: readonly PbContainerStat[],
): boolean {
  if (stats.length === 0) return false;
  if (stats.some((s) => s.state === "restarting")) return false;
  return stats.some((s) => (s.state ? s.state === "running" : s.running));
}

/**
 * Clear `error` off every App on `serverId` that this frame proves is running.
 * That is not style: five of the eight writers of this column are UNCONDITIONAL,
 * so a read-then-decide would lose every race against a deploy landing in the gap.
 */
export async function reconcileAppStatusFromTelemetry(
  serverId: string,
  byProject: ReadonlyMap<string, readonly PbContainerStat[]>,
): Promise<string[]> {
  // Database ids ride the same `deplo.project` label; they simply match no row in
  // `apps` and drop out of the UPDATE, so they need no special case here.
  const running: string[] = [];
  // `restarting` is the crash-loop signal `telemetrySaysRunning` has always
  // computed and discarded. Collected here, where the frame already is, and
  // handed to the alerting side, which owns the hysteresis and writes nothing.
  const crashing: string[] = [];
  for (const [id, stats] of byProject) {
    if (telemetrySaysRunning(stats)) running.push(id);
    else if (stats.some((s) => s.state === "restarting")) crashing.push(id);
  }
  void reportAppHealth(serverId, crashing, running).catch((e) =>
    console.error("[deplo] app health alerting failed:", e),
  );
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

    // Publish only what actually changed.
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
