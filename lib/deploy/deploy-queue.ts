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
 *
 * WHAT IT GUARANTEES
 *  - Deploys are serialized PER OWNING SERVER: each server runs at most
 *    `servers.deploy_concurrency` deploys at once (default 1). Deploys on
 *    DIFFERENT servers run in parallel.
 *  - Two deploys of the SAME app never overlap, even when a server's
 *    concurrency is > 1, AND even when they land in different lanes because the
 *    app's build server changed between them (an app's stack is single-writer).
 *    The exclusion is on the deploy KEY and is global - see `busyKeys`.
 *
 * HOW IT WORKS
 *  The `deployments` row with `status = 'queued'` IS the durable queue; this
 *  module is only the in-process dispatcher. A freshly-inserted queued deploy is
 *  handed here via {@link enqueueDeployment}, which wakes its server's "lane". A
 *  lane is an in-memory semaphore (Coolify's `next_queuable` count) plus a
 *  same-app exclusion set; a single coalesced pump per server claims the
 *  oldest eligible queued row and runs it, re-draining after each finish
 *  (Coolify's `queue_next_deployment`). The atomic `queued -> building` hand-off
 *  is the conditional UPDATE already inside `runDeployment` — so a cancel that
 *  raced the wait simply makes the claim match 0 rows and the runner bails.
 *
 * Singleton on `globalThis` via `Symbol.for(...)` — the same reasoning as
 * {@link ../data/keyed-mutex} and the Drizzle client: Next builds the RSC and
 * route-handler module graphs separately, so a per-module registry would give
 * each graph its own lanes and a deploy enqueued in one graph wouldn't be
 * accounted for in the other. `next start` is single-process, so the in-memory
 * semaphore is a real gate here (a multi-process deploy would need a DB lock).
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
 * keeps two deploys of one stack from overlapping.
 *
 * GLOBAL, not per-lane, and that is load-bearing now that a lane can be a BUILD
 * SERVER. Two production deploys of one app used to be guaranteed into the same
 * lane (the app's own server); with build servers they can land in different ones -
 * the least-busy tie-break makes it likely, not rare, as soon as a fleet has two
 * builders. Per-lane sets would let them run at once and, worse, finish out of
 * order, leaving the app on the OLDER commit.
 *
 * Keyed on the deploy key rather than the app id because the key IS the stack: a
 * preview (`<slug>__pr-3`) and production (`<slug>`) touch different containers,
 * different volumes and different routers, so they may legitimately overlap. Two
 * deploys sharing a key never may.
 *
 * On `globalThis` for the same reason `lanes` is: Next builds the RSC and
 * route-handler graphs separately, and a per-module set would give each its own.
 */
const busyKeys: Set<string> = (g[BUSY_KEY] ??= new Set());

/**
 * Which server's lane a deploy occupies: the BUILD server when it has one,
 * otherwise the host it runs on.
 *
 * The build is where the cost is - CPU, RAM and disk for minutes - while the
 * release is a `compose up` measured in seconds. Counting a deploy against the tiny
 * host it lands on would let ten small servers at concurrency 1 each aim ten
 * simultaneous builds at one builder, which is the opposite of what a build server
 * is for. The same-app exclusion is keyed on the APP either way, so two deploys of
 * one app still never overlap.
 *
 * The known cost is the mirror image: several apps that share a builder can now
 * reach their own (different) hosts at once. That is the cheap phase, and a host
 * that cannot survive two concurrent `compose up`s has a problem this queue was
 * never going to solve.
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
 * The runner the queue invokes for one deployment. Defaults to the real
 * fire-and-forget build ({@link runDeploymentGuarded}); tests swap it for a
 * controllable fake via {@link __setRunnerForTest}. Read at call time (never
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
 * isn't already busy (in-memory exclusion). Scans the small queued backlog for
 * the server (index-backed, partial `deployments_queued_server_idx`).
 *
 * PRODUCTION FIRST, then FIFO by `(createdAt, seq)` — the same total order the
 * deployments list uses, applied within each class. Without the first key, a
 * repository with several open pull requests could queue a wall of preview
 * builds ahead of the production deploy somebody is waiting on; a preview is
 * never urgent in the way a release is. The ordering is over the queued backlog
 * only, so it needs no new index.
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
      // A slot freed - try to start whatever is next (Coolify's
      // queue_next_deployment, called from transitionToStatus on every finish).
      //
      // EVERY lane, not just this one. The stack key that was just released is
      // global, so the deploy it was blocking may be queued on a different
      // builder's lane; waking only the lane that finished would leave that one
      // parked forever with nothing left to re-arm it. One extra query per known
      // lane per finish, on a list the size of the fleet, is the cheap half of
      // that trade.
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
 * The single drain loop for a server. While there's a wake-up pending, fill every
 * free slot with the next eligible queued deploy. Correctness of the coalescing:
 * the only `await`s are `concurrencyFor`/`pickNext`; a wake-up that lands during
 * one flips `dirty`, caught by the outer `while`. A wake-up that lands after the
 * `while` exits but before `pumping` is cleared is caught by the trailing re-check
 * (no `await` separates the `while` exit, the `pumping = false`, and that check,
 * so nothing can interleave and be lost).
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
    // concurrencyFor/pickNext hit the DB; a transient failure (a Postgres
    // blip) must not strand the queued backlog with nothing left to re-arm
    // the lane — `dirty` was already cleared when the await rejected. Log and
    // re-drain after a short backoff (the startOne .catch().finally()
    // contract, applied to the pump itself).
    console.error("[deplo] deploy queue pump failed:", e);
    // `unref()`: the re-arm must not, by itself, hold the process open. The real
    // server has plenty of other handles; a test harness (or a CLI task) has
    // none, and an un-unref'd retry there keeps a finished process alive forever
    // re-trying against a database that has already been torn down.
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
 * `startDeployment`) never awaits the build. The `appId` is unused by the
 * dispatch (the pump re-reads eligibility from the DB) but is part of the contract
 * so the call site reads as "enqueue THIS deploy of THIS app on THAT server".
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
 * restart mid-queue never discards work. Defensively backfills any queued row
 * missing its denormalized `server_id` from the owning app, so none is
 * stranded (the migration backfilled existing rows and every insert sets it; this
 * only catches a straggler).
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
