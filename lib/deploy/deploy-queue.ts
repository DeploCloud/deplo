import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  deployments as deploymentsTable,
  servers as serversTable,
  apps as appsTable,
} from "../db/schema/control-plane";
import { runDeploymentGuarded } from "./build";

/**
 * The per-server deployment queue (the Coolify `concurrent_builds` model, adapted
 * to deplo's single-process, no-Redis architecture).
 */

/** In-flight accounting for one owning server. Memory-only; the durable truth is
 *  the `deployments` table (`status = 'queued' | 'building'`). */
interface ServerLane {
  /** depIds this process currently has running on the server (size <= concurrency). */
  running: Set<string>;
  /** A pump loop is currently executing for this server. */
  pumping: boolean;
  /** A wake-up arrived (enqueue / finish) — the pump makes another pass. */
  dirty: boolean;
}

const REGISTRY_KEY = Symbol.for("deplo.deploy.queue.lanes");
const BUSY_KEY = Symbol.for("deplo.deploy.queue.busy");
const g = globalThis as unknown as {
  [REGISTRY_KEY]?: Map<string, ServerLane>;
  [BUSY_KEY]?: Set<string>;
};
const lanes: Map<string, ServerLane> = (g[REGISTRY_KEY] ??= new Map());

/**
 * The deploy KEYS with a deploy in flight, across every lane - the exclusion that
 * keeps two deploys of one stack from overlapping. Two deploys sharing a key never
 * may.
 */
const busyKeys: Set<string> = (g[BUSY_KEY] ??= new Set());

/**
 * Which server's lane a deploy occupies: the BUILD server when it has one,
 * otherwise the host it runs on. The same-app exclusion is keyed on the APP either
 * way, so two deploys of one app still never overlap.
 */
const laneKey = sql<string>`coalesce(${deploymentsTable.buildServerId}, ${deploymentsTable.serverId})`;

function laneFor(serverId: string): ServerLane {
  let lane = lanes.get(serverId);
  if (!lane) {
    lane = { running: new Set(), pumping: false, dirty: false };
    lanes.set(serverId, lane);
  }
  return lane;
}

/**
 * The runner the queue invokes for one deployment. Read at call time (never
 * captured at module-eval) so the build.ts <-> deploy-queue.ts import cycle is
 * never load-bearing.
 */
let overrideRunner: ((depId: string) => Promise<void>) | null = null;
function invokeRunner(depId: string): Promise<void> {
  return (overrideRunner ?? runDeploymentGuarded)(depId);
}

/** The effective per-server concurrency (clamped to >= 1). Re-read every pass so
 *  a live edit to `servers.deploy_concurrency` takes effect on the next drain. */
async function concurrencyFor(serverId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: serversTable.deployConcurrency })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  const n = rows[0]?.n ?? 1;
  return n >= 1 ? n : 1;
}

/**
 * The next deploy to run on a server: the oldest eligible queued row whose app
 * isn't already busy (in-memory exclusion).
 */
async function pickNext(
  serverId: string,
): Promise<{ id: string; appId: string; key: string } | null> {
  const rows = await getDb()
    .select({
      id: deploymentsTable.id,
      appId: deploymentsTable.appId,
      deployKey: deploymentsTable.deployKey,
    })
    .from(deploymentsTable)
    .where(and(eq(laneKey, serverId), eq(deploymentsTable.status, "queued")))
    .orderBy(
      asc(
        sql`case when ${deploymentsTable.environment} = 'production' then 0 else 1 end`,
      ),
      asc(deploymentsTable.createdAt),
      asc(deploymentsTable.seq),
    );
  for (const r of rows) {
    // A legacy row with no key falls back to the app id, which is what the
    // exclusion used to be - never an empty string, which every row would share.
    const key = r.deployKey || r.appId;
    if (!busyKeys.has(key)) return { id: r.id, appId: r.appId, key };
  }
  return null;
}

/** Run one reserved deploy, freeing its slot + re-draining the server on finish. */
function startOne(serverId: string, depId: string, key: string): void {
  void invokeRunner(depId)
    // runDeploymentGuarded never rejects; a fake runner might. Swallow so the
    // cleanup + re-drain below always run and no slot is leaked.
    .catch((e) => {
      console.error("[deplo] deploy runner crashed:", e);
    })
    .finally(() => {
      const lane = laneFor(serverId);
      lane.running.delete(depId);
      busyKeys.delete(key);
      // A slot freed - try to start whatever is next (Coolify's queue_next_deployment,
      // called from transitionToStatus on every finish).
      scheduleServer(serverId);
      for (const other of [...lanes.keys()]) {
        if (other !== serverId) scheduleServer(other);
      }
    });
}

/**
 * Wake a server's lane: mark it dirty and ensure exactly one pump loop is
 * running. Safe to call from anywhere (enqueue, finish, boot) and any number of
 * times — extra calls coalesce into the single loop via the `dirty` flag.
 */
export function scheduleServer(serverId: string): void {
  const lane = laneFor(serverId);
  lane.dirty = true;
  if (lane.pumping) return;
  lane.pumping = true;
  void pump(serverId, lane);
}

/**
 * The single drain loop for a server.
 */
async function pump(serverId: string, lane: ServerLane): Promise<void> {
  try {
    while (lane.dirty) {
      lane.dirty = false;
      const concurrency = await concurrencyFor(serverId);
      while (lane.running.size < concurrency) {
        const next = await pickNext(serverId);
        if (!next) break;
        // Reserve the slot in memory BEFORE the runner claims queued->building,
        // so a re-drain in the same tick can't pick the same stack twice.
        lane.running.add(next.id);
        busyKeys.add(next.key);
        startOne(serverId, next.id, next.key);
      }
    }
  } catch (e) {
    // concurrencyFor/pickNext hit the DB; a transient failure (a Postgres blip) must
    // not strand the queued backlog with nothing left to re-arm the lane — `dirty` was
    // already cleared when the await rejected.
    console.error("[deplo] deploy queue pump failed:", e);
    // `unref()`: the re-arm must not, by itself, hold the process open.
    setTimeout(() => scheduleServer(serverId), 5_000).unref?.();
  } finally {
    lane.pumping = false;
    if (lane.dirty) {
      lane.pumping = true;
      void pump(serverId, lane);
    }
  }
}

/**
 * Enqueue a freshly-inserted `queued` deployment for its owning server and wake
 * that server's lane. Returns immediately — the caller ({@link ../deploy/build}'s
 * `startDeployment`) never awaits the build.
 */
export function enqueueDeployment(input: {
  depId: string;
  serverId: string;
  appId: string;
  /** The BUILD server, when this deploy compiles somewhere other than where it
   *  runs. It owns the lane - see {@link laneKey}. */
  buildServerId?: string | null;
}): void {
  scheduleServer(input.buildServerId || input.serverId);
}

/**
 * Boot entry (called from `reconcileInFlightDeployments` after orphaned `building`
 * rows are errored): re-drain every server that still has a `queued` backlog, so a
 * restart mid-queue never discards work.
 */
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
  // The LANE, not the owning server: a backlog waiting on a build server must wake
  // that builder's lane, or a restart would leave it parked forever behind a lane
  // nothing ever schedules.
  const servers = await db
    .selectDistinct({ serverId: laneKey })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.status, "queued"));
  for (const s of servers) {
    if (s.serverId) scheduleServer(s.serverId);
  }
}

/* ------------------------------------------------------------------ */
/* Test seams (named to dodge the *.test.ts glob; no-ops in prod).      */
/* ------------------------------------------------------------------ */

/** Substitute the deploy runner (tests drive a controllable fake). */
export function __setRunnerForTest(fn: (depId: string) => Promise<void>): void {
  overrideRunner = fn;
}

/** Restore the real runner and clear all lane state (call between tests). */
export function __resetQueueForTest(): void {
  overrideRunner = null;
  lanes.clear();
  busyKeys.clear();
}

/** Snapshot a server lane's in-flight accounting (test assertions only). */
export function __laneSnapshotForTest(serverId: string): {
  running: string[];
  busyApps: string[];
} {
  const lane = lanes.get(serverId);
  return {
    running: lane ? [...lane.running] : [],
    // The exclusion set is global now (see `busyKeys`); the name is kept so the
    // existing assertions read the same, and it holds deploy KEYS.
    busyApps: [...busyKeys],
  };
}
