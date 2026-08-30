import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  instanceSettings,
} from "../db/schema/control-plane";
import { nowIso } from "../ids";
import { recordActivity } from "../data/activity";
import { reapplyDatabaseNetwork } from "../data/databases";
import { usesAsHost } from "./cross-network";
import { rerouteApp } from "./build";

/**
 * Move every existing stack onto the network its placement owns - the one-time
 * migration from the single shared network.
 * https://deplo.build/docs/advanced/network-isolation
 *
 * Serial per host on purpose: this is a bring-up of every container on a machine,
 * and doing them at once would put an instance's whole fleet under load during an
 * upgrade. A stack that cannot be moved is LEFT WHERE IT IS - the old network still
 * exists and Traefik is still on it - so the failure is a delay, never an outage,
 * and the next deploy finishes the job.
 */
export async function runNetworkIsolationSweep(): Promise<void> {
  const db = getDb();
  // Claim the sweep: one UPDATE, so a second control plane on the same database
  // finds no unclaimed row and does nothing.
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

  // Group by host, then work one host at a time.
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
        await rerouteApp(id);
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
      : `Network isolation applied, ${failed} stack${failed === 1 ? "" : "s"} could not be moved and stayed where they were`,
    "Deplo",
    null,
    null,
  );
}

/**
 * Give each placement-less database the Environment that actually uses it, when
 * exactly one does. Ambiguous (two Environments) or unused stays at the team
 * level: guessing there would take a database away from half its callers.
 */
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

  // Every app that could name one, with the Environment it would pull it into.
  // Resolved ONCE per app: decrypting an app's env for each loose database in
  // turn is the same answer computed N times.
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
    if (!app.environmentId) continue;
    haystack.set(app.id, {
      env: await safeAppEnv(app.id),
      compose: (app.compose ?? "").toLowerCase(),
    });
  }

  let placed = 0;
  for (const d of loose) {
    const envs = new Set<string>();
    for (const app of users) {
      if (!app.environmentId) continue;
      // Same TEAM and same HOST, or this would file one team's database into
      // another team's Environment because both happened to use the name.
      if (app.teamId !== d.teamId || app.serverId !== d.serverId) continue;
      const h = haystack.get(app.id);
      if (!h) continue;
      const named =
        h.compose.includes(d.host.toLowerCase()) ||
        Object.entries(h.env).some(([k, v]) => usesAsHost(k, v, d.host));
      if (named) envs.add(app.environmentId);
    }
    if (envs.size !== 1) continue;
    await db
      .update(databasesTable)
      .set({ environmentId: [...envs][0] })
      .where(
        and(eq(databasesTable.id, d.id), isNull(databasesTable.environmentId)),
      );
    placed++;
  }
  return placed;
}

/** An app's resolved env, or nothing when it cannot be read. */
async function safeAppEnv(appId: string): Promise<Record<string, string>> {
  try {
    const { appEnv } = await import("./build");
    return await appEnv(appId);
  } catch {
    return {};
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What the Overview banner reads: how many stacks the sweep left behind. */
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

/** Re-run the sweep - the banner's "Try again". */
export async function retryNetworkIsolationSweep(): Promise<void> {
  await getDb()
    .update(instanceSettings)
    .set({ networkSweepAt: null, updatedAt: nowIso() })
    .where(eq(instanceSettings.id, "default"));
  await runNetworkIsolationSweep();
}
