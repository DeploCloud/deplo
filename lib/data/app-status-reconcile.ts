import "server-only";

import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { publishAppChanged } from "../graphql/pubsub";
import { nowIso } from "../ids";
import type { ContainerStat as PbContainerStat } from "../agent/gen/agent";
import type { Deployment } from "../types/deployment";
import { reportAppHealth } from "../notify/apps";

const IN_PROGRESS: Deployment["status"][] = ["queued", "building"];

// Keying strictly on `state` would switch this off for part of a mixed-version fleet.
export function telemetrySaysRunning(
  stats: readonly PbContainerStat[],
): boolean {
  if (stats.length === 0) return false;
  if (stats.some((s) => s.state === "restarting")) return false;
  return stats.some((s) => (s.state ? s.state === "running" : s.running));
}

// Clear `error` off every App on `serverId` that this frame proves is running.
// Unconditional on purpose: 5 of the 8 writers of this column are too, so a
// read-then-decide would lose every race with a deploy landing in the gap.
export async function reconcileAppStatusFromTelemetry(
  serverId: string,
  byProject: ReadonlyMap<string, readonly PbContainerStat[]>,
): Promise<string[]> {
  const running: string[] = [];
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

    for (const row of corrected) publishAppChanged(row.id);
    if (corrected.length > 0) {
      console.log(
        `[deplo] telemetry cleared a stale "error" on ${corrected.length} app(s): ` +
          corrected.map((r) => r.id).join(", "),
      );
    }
    return corrected.map((r) => r.id);
  } catch (e) {
    // Best-effort: a DB blip must never take down the telemetry stream.
    console.error("[deplo] reconcileAppStatusFromTelemetry failed:", e);
    return [];
  }
}
