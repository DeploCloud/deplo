import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { nowIso } from "../ids";
import { recordActivity } from "../data/activity";
import { requireInstanceAdmin } from "../membership";
import { reapplyDatabaseNetwork } from "../data/databases/environment-move";
import { usesAsHost } from "./cross-network";
import { rerouteApp } from "./build/reroute";

export async function runNetworkIsolationSweep(): Promise<void> {
  const db = getDb();
  const claimed = await db
    .update(instanceSettings)
    .set({ networkSweepAt: nowIso(), updatedAt: nowIso() })
    .where(isNull(instanceSettings.networkSweepAt))
    .returning({ id: instanceSettings.id });
  if (claimed.length === 0) return;

  const placed = await placeDatabasesByUsage();
  if (placed > 0)
    await recordActivity(
      "database",
      `Network isolation: ${placed} database${placed === 1 ? "" : "s"} placed in the environment that uses ${placed === 1 ? "it" : "them"}`,
      "Deplo",
      null,
      null,
    );

  const apps = await db
    .select({ id: appsTable.id, serverId: appsTable.serverId })
    .from(appsTable);
  const dbs = await db
    .select({ id: databasesTable.id, serverId: databasesTable.serverId })
    .from(databasesTable);

  const byServer = new Map<string, { apps: string[]; dbs: string[] }>();
  const bucket = (s: string) => {
    let b = byServer.get(s);
    if (!b) byServer.set(s, (b = { apps: [], dbs: [] }));
    return b;
  };
  for (const a of apps) bucket(a.serverId).apps.push(a.id);
  for (const d of dbs) bucket(d.serverId).dbs.push(d.id);

  let failed = 0;
  for (const [, work] of byServer) {
    for (const id of work.apps) {
      try {
        if ((await rerouteApp(id)) === "deferred") {
          failed++;
          await recordActivity(
            "app",
            `Network isolation: this app was not running, so it stays on the old network until it is started or deployed`,
            "Deplo",
            id,
            null,
          );
        }
      } catch (e) {
        failed++;
        await recordActivity(
          "app",
          `Network isolation: could not move this app onto its environment's network - ${message(e)}`,
          "Deplo",
          id,
          null,
        );
      }
    }
    failed += await reapplyDatabaseNetwork(work.dbs);
  }

  await db
    .update(instanceSettings)
    .set({ networkSweepFailed: failed, updatedAt: nowIso() })
    .where(eq(instanceSettings.id, "default"));
  await recordActivity(
    "app",
    failed === 0
      ? `Network isolation applied: every app and database is on its own environment's network`
      : `Network isolation applied, ${failed} stack${failed === 1 ? "" : "s"} stayed on the old network - a stopped one moves when it next starts`,
    "Deplo",
    null,
    null,
  );
}

async function placeDatabasesByUsage(): Promise<number> {
  const db = getDb();
  const loose = await db
    .select({
      id: databasesTable.id,
      host: databasesTable.host,
      teamId: databasesTable.teamId,
      serverId: databasesTable.serverId,
    })
    .from(databasesTable)
    .where(isNull(databasesTable.environmentId));
  if (loose.length === 0) return 0;

  const users = await db
    .select({
      environmentId: appsTable.environmentId,
      compose: appsTable.compose,
      id: appsTable.id,
      teamId: appsTable.teamId,
      serverId: appsTable.serverId,
    })
    .from(appsTable);
  const haystack = new Map<
    string,
    { env: Record<string, string>; compose: string }
  >();
  for (const app of users) {
    haystack.set(app.id, {
      env: await safeAppEnv(app.id),
      compose: (app.compose ?? "").toLowerCase(),
    });
  }

  let placed = 0;
  for (const d of loose) {
    const places = new Set<string>();
    for (const app of users) {
      if (app.teamId !== d.teamId || app.serverId !== d.serverId) continue;
      const h = haystack.get(app.id);
      if (!h) continue;
      const named =
        h.compose.includes(d.host.toLowerCase()) ||
        Object.entries(h.env).some(([k, v]) => usesAsHost(k, v, d.host));
      if (named) places.add(app.environmentId ?? "");
    }
    const only = soleEnvironmentUsing(places);
    if (!only) {
      if (places.size > 1)
        await recordActivity(
          "database",
          `Network isolation: ${d.host} is used from more than one place, so it stayed at the team's top level - apps inside an environment will no longer reach it by name. Move it, or the database, to put them together.`,
          "Deplo",
          null,
          d.teamId,
          null,
          d.id,
        );
      continue;
    }
    await db
      .update(databasesTable)
      .set({ environmentId: only })
      .where(
        and(eq(databasesTable.id, d.id), isNull(databasesTable.environmentId)),
      );
    placed++;
  }
  return placed;
}

export function soleEnvironmentUsing(places: Set<string>): string | null {
  if (places.size !== 1) return null;
  return [...places][0] || null;
}

async function safeAppEnv(appId: string): Promise<Record<string, string>> {
  try {
    const { appEnv } = await import("./build/deploy-env");
    return await appEnv(appId);
  } catch {
    return {};
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function networkSweepFailures(): Promise<number> {
  const row = (
    await getDb()
      .select({ failed: instanceSettings.networkSweepFailed })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, "default"))
      .limit(1)
  )[0];
  return row?.failed ?? 0;
}

export async function retryNetworkIsolationSweep(): Promise<void> {
  await requireInstanceAdmin();
  await getDb()
    .update(instanceSettings)
    .set({ networkSweepAt: null, updatedAt: nowIso() })
    .where(eq(instanceSettings.id, "default"));
  await runNetworkIsolationSweep();
}
