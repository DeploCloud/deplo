import "server-only";

import { and, asc, eq, isNull, sql, count } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { runDeploymentGuarded } from "./build/deploy-run";

interface ServerLane {
  running: Set<string>;
  pumping: boolean;
  dirty: boolean;
}

const REGISTRY_KEY = Symbol.for("deplo.deploy.queue.lanes");
const BUSY_KEY = Symbol.for("deplo.deploy.queue.busy");
const g = globalThis as unknown as {
  [REGISTRY_KEY]?: Map<string, ServerLane>;
  [BUSY_KEY]?: Set<string>;
};
const lanes: Map<string, ServerLane> = (g[REGISTRY_KEY] ??= new Map());

const busyKeys: Set<string> = (g[BUSY_KEY] ??= new Set());

const laneKey = sql<string>`coalesce(${deploymentsTable.buildServerId}, ${deploymentsTable.serverId})`;

function laneFor(serverId: string): ServerLane {
  let lane = lanes.get(serverId);
  if (!lane) {
    lane = { running: new Set(), pumping: false, dirty: false };
    lanes.set(serverId, lane);
  }
  return lane;
}

let overrideRunner: ((depId: string) => Promise<void>) | null = null;
function invokeRunner(depId: string): Promise<void> {
  return (overrideRunner ?? runDeploymentGuarded)(depId);
}

async function concurrencyFor(serverId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: serversTable.deployConcurrency })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  const n = rows[0]?.n ?? 1;
  return n >= 1 ? n : 1;
}

async function pickNext(
  serverId: string,
): Promise<{ id: string; appId: string; key: string } | null> {
  const rows = await getDb()
    .select({
      id: deploymentsTable.id,
      appId: deploymentsTable.appId,
      deployKey: deploymentsTable.deployKey,
      teamId: appsTable.teamId,
    })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(appsTable.id, deploymentsTable.appId))
    .where(and(eq(laneKey, serverId), eq(deploymentsTable.status, "queued")))
    .orderBy(
      asc(
        sql`case when ${deploymentsTable.environment} = 'production' then 0 else 1 end`,
      ),
      asc(deploymentsTable.createdAt),
      asc(deploymentsTable.seq),
    );
  const running = new Map<string, number>();
  for (const r of await getDb()
    .select({ teamId: appsTable.teamId, n: count() })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(appsTable.id, deploymentsTable.appId))
    .where(and(eq(laneKey, serverId), eq(deploymentsTable.status, "building")))
    .groupBy(appsTable.teamId))
    running.set(r.teamId, Number(r.n));
  let best: (typeof rows)[number] | null = null;
  for (const r of rows) {
    const key = r.deployKey || r.appId;
    if (busyKeys.has(key)) continue;
    if (!best || (running.get(r.teamId) ?? 0) < (running.get(best.teamId) ?? 0))
      best = r;
  }
  if (best)
    return {
      id: best.id,
      appId: best.appId,
      key: best.deployKey || best.appId,
    };
  return null;
}

function startOne(serverId: string, depId: string, key: string): void {
  void invokeRunner(depId)
    .catch((e) => {
      console.error("[deplo] deploy runner crashed:", e);
    })
    .finally(() => {
      const lane = laneFor(serverId);
      lane.running.delete(depId);
      busyKeys.delete(key);
      scheduleServer(serverId);
      for (const other of [...lanes.keys()]) {
        if (other !== serverId) scheduleServer(other);
      }
    });
}

export function scheduleServer(serverId: string): void {
  const lane = laneFor(serverId);
  lane.dirty = true;
  if (lane.pumping) return;
  lane.pumping = true;
  void pump(serverId, lane);
}

async function pump(serverId: string, lane: ServerLane): Promise<void> {
  try {
    while (lane.dirty) {
      lane.dirty = false;
      const concurrency = await concurrencyFor(serverId);
      while (lane.running.size < concurrency) {
        const next = await pickNext(serverId);
        if (!next) break;
        lane.running.add(next.id);
        busyKeys.add(next.key);
        startOne(serverId, next.id, next.key);
      }
    }
  } catch (e) {
    console.error("[deplo] deploy queue pump failed:", e);
    setTimeout(() => scheduleServer(serverId), 5_000).unref?.();
  } finally {
    lane.pumping = false;
    if (lane.dirty) {
      lane.pumping = true;
      void pump(serverId, lane);
    }
  }
}

export function enqueueDeployment(input: {
  depId: string;
  serverId: string;
  appId: string;
  buildServerId?: string | null;
}): void {
  scheduleServer(input.buildServerId || input.serverId);
}

export async function startDeployQueue(): Promise<void> {
  const db = getDb();
  const orphans = await db
    .select({ id: deploymentsTable.id, appId: deploymentsTable.appId })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.status, "queued"),
        isNull(deploymentsTable.serverId),
      ),
    );
  for (const o of orphans) {
    const svc = await db
      .select({ serverId: appsTable.serverId })
      .from(appsTable)
      .where(eq(appsTable.id, o.appId))
      .limit(1);
    if (svc[0]?.serverId) {
      await db
        .update(deploymentsTable)
        .set({ serverId: svc[0].serverId })
        .where(eq(deploymentsTable.id, o.id));
    }
  }
  const servers = await db
    .selectDistinct({ serverId: laneKey })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.status, "queued"));
  for (const s of servers) {
    if (s.serverId) scheduleServer(s.serverId);
  }
}

export function __setRunnerForTest(fn: (depId: string) => Promise<void>): void {
  overrideRunner = fn;
}

export function __resetQueueForTest(): void {
  overrideRunner = null;
  lanes.clear();
  busyKeys.clear();
}

export function __laneSnapshotForTest(serverId: string): {
  running: string[];
  busyApps: string[];
} {
  const lane = lanes.get(serverId);
  return {
    running: lane ? [...lane.running] : [],
    busyApps: [...busyKeys],
  };
}
