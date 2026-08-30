// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  deployments as deploymentsTable,
} from "../db/schema/control-plane";
import { dispatchAlert } from "./dispatch";
import { shouldFire } from "./cooldown";

/**
 * "This app keeps dying" - the signal `telemetrySaysRunning` has always computed
 * and thrown away. Adding a ninth writer on a 30s clock would start a write-war
 * with the deploy pipeline for a fact the UI already displays correctly.
 */

const KEY = Symbol.for("deplo.notify.crashloop");
/** App ids seen restarting on the PREVIOUS reconcile, per server. */
const lastSeen = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<
  string,
  Set<string>
>()) as Map<string, Set<string>>;

const ALERTED_KEY = Symbol.for("deplo.notify.crashloop.alerted");
/**
 * App ids we have actually raised a crash-loop alert for. Recovery is announced
 * ONLY for these, otherwise every healthy app in the fleet would report itself
 * "running again" on the first reconcile after a restart.
 */
const alerted = ((globalThis as Record<symbol, unknown>)[ALERTED_KEY] ??=
  new Set<string>()) as Set<string>;

/**
 * Report this server's crash-looping apps for one reconcile pass. Both are needed:
 * the healthy list is what closes an open alert, and closing it costs a `Map.get`
 * per app because `shouldFire` is asked first.
 */
export async function reportAppHealth(
  serverId: string,
  crashing: string[],
  healthy: string[],
): Promise<void> {
  const previous = lastSeen.get(serverId) ?? new Set<string>();
  lastSeen.set(serverId, new Set(crashing));

  // Recovered: an app we ACTUALLY warned about that the frame now says is up.
  const recovered = healthy.filter(
    (id) =>
      alerted.delete(id) && shouldFire("app_crash_loop", `app:${id}`, "ok"),
  );
  // Confirmed: restarting on this pass AND on the one before it.
  const confirmed = crashing.filter((id) => previous.has(id));
  if (confirmed.length === 0 && recovered.length === 0) return;

  try {
    const rows = await appRows(serverId, [...confirmed, ...recovered]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of confirmed) {
      const app = byId.get(id);
      if (!app) continue;
      alerted.add(id);
      dispatchAlert({
        teamId: app.teamId,
        key: "app_crash_loop",
        dedupe: { id: `app:${id}`, state: "crashloop" },
        title: `${app.name} keeps restarting`,
        body: "Its container starts, exits and starts again. The logs have why.",
        path: `/apps/${app.slug}`,
      });
    }
    for (const id of recovered) {
      const app = byId.get(id);
      if (!app) continue;
      dispatchAlert({
        teamId: app.teamId,
        key: "app_crash_loop",
        title: `${app.name} is running again`,
        body: "It stopped restarting and is up.",
        path: `/apps/${app.slug}`,
      });
    }
  } catch (e) {
    // Best-effort, like the reconcile that calls us: a DB blip must never take
    // down the telemetry stream.
    console.error("[deplo] app health alerting failed:", e);
  }
}

/**
 * The apps behind those ids, with the same correctness guards the status
 * reconcile uses: this host must own them, they must not be mid-migration, and
 * an app with a deploy in flight is being worked on rather than failing.
 */
async function appRows(serverId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return getDb()
    .select({
      id: appsTable.id,
      teamId: appsTable.teamId,
      name: appsTable.name,
      slug: appsTable.slug,
    })
    .from(appsTable)
    .where(
      and(
        inArray(appsTable.id, ids),
        eq(appsTable.serverId, serverId),
        isNull(appsTable.migrateFromServerId),
        notExists(
          getDb()
            .select({ one: sql`1` })
            .from(deploymentsTable)
            .where(
              and(
                eq(deploymentsTable.appId, appsTable.id),
                inArray(deploymentsTable.status, ["queued", "building"]),
              ),
            ),
        ),
      ),
    );
}

/** Test hook - the previous-pass maps outlive a single test file otherwise. */
export function __resetAppHealth(): void {
  lastSeen.clear();
  alerted.clear();
}
