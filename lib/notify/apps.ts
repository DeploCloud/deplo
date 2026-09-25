import "server-only";

import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { dispatchAlert } from "./dispatch";
import { shouldFire } from "./cooldown";
import { newOomKills } from "../monitoring/oom";
import type { ContainerStat } from "../agent/gen/agent";

const KEY = Symbol.for("deplo.notify.crashloop");
const lastSeen = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<
  string,
  Set<string>
>()) as Map<string, Set<string>>;

// app id -> the server it was alerted on.
const ALERTED_KEY = Symbol.for("deplo.notify.crashloop.alerted-by-server");
const alerted = ((globalThis as Record<symbol, unknown>)[ALERTED_KEY] ??=
  new Map<string, string>()) as Map<string, string>;

// An alerted app its server no longer reports (deleted, stopped, moved) will never recover.
export function pruneAlerted(
  alertedOn: Map<string, string>,
  serverId: string,
  reported: ReadonlySet<string>,
): void {
  for (const [id, srv] of alertedOn)
    if (srv === serverId && !reported.has(id)) alertedOn.delete(id);
}

export async function reportAppHealth(
  serverId: string,
  crashing: string[],
  healthy: string[],
): Promise<void> {
  const previous = lastSeen.get(serverId) ?? new Set<string>();
  lastSeen.set(serverId, new Set(crashing));

  const recovered = healthy.filter(
    (id) =>
      alerted.delete(id) && shouldFire("app_crash_loop", `app:${id}`, "ok"),
  );
  pruneAlerted(alerted, serverId, new Set([...crashing, ...healthy]));
  const confirmed = crashing.filter((id) => previous.has(id));
  if (confirmed.length === 0 && recovered.length === 0) return;

  try {
    const rows = await appRows(serverId, [...confirmed, ...recovered]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of confirmed) {
      const app = byId.get(id);
      if (!app) continue;
      alerted.set(id, serverId);
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
    console.error("[deplo] app health alerting failed:", e);
  }
}

export async function reportOutOfMemory(
  serverId: string,
  byProject: ReadonlyMap<string, readonly ContainerStat[]>,
): Promise<void> {
  const hits = new Set(
    newOomKills(serverId, [...byProject.values()].flat()).map((s) => s.name),
  );
  if (hits.size === 0) return;
  const killed = [...byProject]
    .filter(([, stats]) => stats.some((s) => hits.has(s.name)))
    .map(([id]) => id);
  for (const app of await appRows(serverId, killed))
    dispatchAlert({
      teamId: app.teamId,
      key: "app_out_of_memory",
      dedupe: { id: `app:${app.id}`, state: "oom" },
      title: `${app.name} ran out of memory`,
      body: "It used all the memory it may use and was killed. Give it more under Resources, or look for a leak in the logs.",
      path: `/apps/${app.slug}`,
    });
}

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
