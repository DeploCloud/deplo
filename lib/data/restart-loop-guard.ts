import "server-only";

import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { connectAgent } from "../infra/agent-client/connect";
import { STOP_SERVICES_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { stopContainer } from "../deploy/build/stack-lifecycle";
import {
  RESTART_LOOP_THRESHOLD,
  forgetContainers,
  loopingContainers,
} from "../monitoring/restart-loop";
import { publishAppChanged } from "../graphql/pubsub";
import { dispatchAlert } from "../notify/dispatch";
import { recordActivity } from "./activity";
import { nowIso } from "../ids";
import type { ContainerStat } from "../agent/gen/agent";

const STOPPED_BODY = `It restarted ${RESTART_LOOP_THRESHOLD} times in half an hour, so Deplo stopped it. The logs have why.`;

/**
 * Stops what keeps crashing, so a loop cannot burn the host's CPU and disk forever.
 * Previews are out: their containers carry a preview id, which matches no app row.
 */
export async function stopLoopingWorkloads(
  serverId: string,
  byProject: ReadonlyMap<string, readonly ContainerStat[]>,
): Promise<void> {
  const samples = [...byProject.values()].flat();
  const looping = new Set(loopingContainers(serverId, samples));
  if (looping.size === 0) return;

  const byId = new Map<string, string[]>();
  for (const [id, stats] of byProject) {
    const hit = stats.filter((s) => looping.has(s.name)).map((s) => s.name);
    if (hit.length > 0) byId.set(id, hit);
  }

  const ids = [...byId.keys()];
  const [apps, databases] = await Promise.all([
    guardedApps(serverId, ids),
    guardedDatabases(serverId, ids),
  ]);

  for (const app of apps)
    await stopOne(serverId, {
      id: app.id,
      teamId: app.teamId,
      name: app.name,
      deployKey: app.slug,
      containers: byId.get(app.id) ?? [],
      isComposeStack: app.source === "compose",
      path: `/apps/${app.slug}`,
      markStopped: () =>
        getDb()
          .update(appsTable)
          .set({
            status: "error",
            restartLoopStoppedAt: nowIso(),
            updatedAt: nowIso(),
          })
          .where(eq(appsTable.id, app.id))
          .then(() => publishAppChanged(app.id)),
      activity: (message: string) =>
        recordActivity("app", message, "Deplo", app.id),
    });

  for (const db of databases)
    await stopOne(serverId, {
      id: db.id,
      teamId: db.teamId,
      name: db.name,
      deployKey: db.host,
      containers: byId.get(db.id) ?? [],
      isComposeStack: false,
      path: `/storage/databases/${db.id}`,
      markStopped: () =>
        getDb()
          .update(databasesTable)
          .set({ status: "error", restartLoopStoppedAt: nowIso() })
          .where(eq(databasesTable.id, db.id))
          .then(() => undefined),
      activity: (message: string) =>
        recordActivity(
          "database",
          message,
          "Deplo",
          null,
          db.teamId,
          null,
          db.id,
        ),
    });
}

interface StopTarget {
  id: string;
  teamId: string;
  name: string;
  deployKey: string;
  containers: string[];
  isComposeStack: boolean;
  path: string;
  markStopped: () => Promise<unknown>;
  activity: (message: string) => Promise<void>;
}

async function stopOne(serverId: string, t: StopTarget): Promise<void> {
  try {
    const services = t.isComposeStack
      ? await servicesFor(serverId, t.id, t.deployKey, t.containers)
      : [];
    if (services === null) return;

    await stopContainer(t.deployKey, services);
    forgetContainers(serverId, t.containers);
    await t.markStopped();
    await t.activity(
      `Stopped ${t.name} after ${RESTART_LOOP_THRESHOLD} restarts`,
    );
    dispatchAlert({
      teamId: t.teamId,
      key: "app_crash_loop",
      dedupe: { id: `app:${t.id}`, state: "crashloop-stopped" },
      title: `${t.name} was stopped`,
      body: STOPPED_BODY,
      path: t.path,
    });
  } catch (e) {
    console.error(`[deplo] restart-loop guard could not stop ${t.name}:`, e);
  }
}

/** The compose services behind the looping containers, or null when this agent cannot stop one. */
async function servicesFor(
  serverId: string,
  appId: string,
  deployKey: string,
  containers: string[],
): Promise<string[] | null> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(STOP_SERVICES_CAPABILITY)) {
      console.warn(
        `[deplo] restart-loop guard skipped ${deployKey}: its server's agent cannot stop one service of a stack`,
      );
      return null;
    }
    const instances = await conn.listInstances(appId, deployKey, "");
    const named = new Set(containers);
    const services = instances
      .filter((i) => named.has(i.name) && i.service)
      .map((i) => i.service);
    return services.length > 0 ? [...new Set(services)] : null;
  } finally {
    conn.close();
  }
}

function noDeployInFlight() {
  return notExists(
    getDb()
      .select({ one: sql`1` })
      .from(deploymentsTable)
      .where(
        and(
          eq(deploymentsTable.appId, appsTable.id),
          inArray(deploymentsTable.status, ["queued", "building"]),
        ),
      ),
  );
}

function guardedApps(serverId: string, ids: string[]) {
  return getDb()
    .select({
      id: appsTable.id,
      teamId: appsTable.teamId,
      name: appsTable.name,
      slug: appsTable.slug,
      source: appsTable.source,
    })
    .from(appsTable)
    .where(
      and(
        inArray(appsTable.id, ids),
        eq(appsTable.serverId, serverId),
        eq(appsTable.restartLoopGuard, true),
        eq(appsTable.status, "active"),
        isNull(appsTable.migrateFromServerId),
        isNull(appsTable.deletingAt),
        noDeployInFlight(),
      ),
    );
}

function guardedDatabases(serverId: string, ids: string[]) {
  return getDb()
    .select({
      id: databasesTable.id,
      teamId: databasesTable.teamId,
      name: databasesTable.name,
      host: databasesTable.host,
    })
    .from(databasesTable)
    .where(
      and(
        inArray(databasesTable.id, ids),
        eq(databasesTable.serverId, serverId),
        eq(databasesTable.restartLoopGuard, true),
        eq(databasesTable.status, "running"),
      ),
    );
}
