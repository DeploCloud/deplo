import "server-only";

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import { gte } from "drizzle-orm";

import { getDb } from "../db/client";
import { dockerCleanupRuns } from "../db/schema/control-plane/docker-cleanup";
import { cronMatches } from "../backups/cron";
import {
  acquireLease,
  releaseLease,
  DOCKER_CLEANUP_LEASE,
} from "../backups/lease";
import { listAllServers } from "../data/servers/roster";
import { serversWithDeploySweepInFlight } from "../data/docker-cleanup/deploy-sweep";
import { loadCleanupPolicyForScheduler } from "../data/docker-cleanup/policy";
import { listServersWithCleanupRunning } from "../data/docker-cleanup/run-history";
import { runScheduledCleanup } from "../data/docker-cleanup/sweep";

const TICK_MS = 60_000;

// A host is OVERDUE once its last sweep STARTED this long ago, so a 3-day outage costs one catch-up sweep, not three.
const CATCHUP_AFTER_MS = 25 * 60 * 60_000;

// A label identifying THIS process as the lease owner across restarts.
function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  // Dedup guard: serverId → the minute key it last fired for, so overlapping ticks can't double-sweep a host.
  lastFired: Map<string, string>;
  // True while a tick is in flight, so a slow tick never overlaps the next.
  ticking: boolean;
}

const STATE_KEY = Symbol.for("deplo.cleanup.scheduler");
const g = globalThis as unknown as { [STATE_KEY]?: SchedulerState };
const state: SchedulerState = (g[STATE_KEY] ??= {
  started: false,
  timer: null,
  owner: makeOwner(),
  lastFired: new Map(),
  ticking: false,
});

function minuteKey(at: Date): string {
  return at.toISOString().slice(0, 16);
}

async function listServersSweptSince(cutoff: Date): Promise<Set<string>> {
  const rows = await getDb()
    .select({ serverId: dockerCleanupRuns.serverId })
    .from(dockerCleanupRuns)
    .where(gte(dockerCleanupRuns.startedAt, cutoff.toISOString()));
  return new Set(
    rows.map((r) => r.serverId).filter((id): id is string => id !== null),
  );
}

// runCleanupSchedulerTick claims the lease and sweeps every server the enabled policy is due on; never throws.
export async function runCleanupSchedulerTick(
  now: Date = new Date(),
): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    // Lease first: no point reading/evaluating if another instance owns the tick.
    const held = await acquireLease(DOCKER_CLEANUP_LEASE, state.owner, now);
    if (!held) return;

    const policy = await loadCleanupPolicyForScheduler();
    if (!policy.enabled) return;
    // updateCleanupPolicy refuses to enable a policy with no scopes, so this only catches a downgrade from a newer build.
    if (policy.scopes.length === 0) return;

    const key = minuteKey(now);
    // The policy is instance-wide, so the cron is one question for every server; only OVERDUE is decided per host.
    const onTime = cronMatches(policy.schedule, now);
    const [servers, running, sweptRecently] = await Promise.all([
      listAllServers(),
      listServersWithCleanupRunning(),
      listServersSweptSince(new Date(now.getTime() - CATCHUP_AFTER_MS)),
    ]);
    const excluded = new Set(policy.excludedServerIds);
    // Deploy-time sweeps leave no history row, and two sweeps on one host race each other's candidate lists.
    const inFlight = new Set([...running, ...serversWithDeploySweepInFlight()]);

    const due = servers.filter((s) => {
      // A migration source is another platform's live host: a sweep would delete THEIR images and build cache.
      if (s.importOnly) return false;
      if (excluded.has(s.id)) return false;
      if (inFlight.has(s.id)) return false;
      if (state.lastFired.get(s.id) === key) return false;
      // A host we have never swept is in no window, so it is overdue by construction and sweeps as soon as the policy is enabled.
      return onTime || !sweptRecently.has(s.id);
    });

    for (const s of due) {
      // A fleet's worth of sequential sweeps outlasts LEASE_STALE_MS, and a stale lease is one another instance can steal and double-sweep.
      if (!(await acquireLease(DOCKER_CLEANUP_LEASE, state.owner))) break;
      // Stamp BEFORE awaiting so an overlapping tick in the same minute can't double-sweep this host.
      state.lastFired.set(s.id, key);
      try {
        // Unprovisioned hosts are not filtered here on purpose: the executor records "never called home" as a failed run.
        await runScheduledCleanup(s.id, s.name, policy);
      } catch (e) {
        // runScheduledCleanup already swallows + records; this is belt-and-braces.
        console.warn(
          `[cleanup] scheduled cleanup on ${s.name} errored: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Bound the dedup map: a host is swept at most once a minute, so older keys are dead weight.
    for (const [id, k] of state.lastFired) {
      if (k !== key) state.lastFired.delete(id);
    }
  } finally {
    state.ticking = false;
  }
}

// startDockerCleanupScheduler starts the once-a-minute loop; idempotent, so two module graphs can't start two loops.
export function startDockerCleanupScheduler(): void {
  if (state.started) return;
  state.started = true;
  // unref() so the interval never keeps an idle process alive on its own.
  const timer = setInterval(() => {
    void runCleanupSchedulerTick();
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
  // An immediate tick is where catch-up earns its keep: a control plane down at 04:00 sweeps at boot, not a day later.
  void runCleanupSchedulerTick();
  console.log("[deplo] docker cleanup scheduler started");
}

// releaseDockerCleanupLease drops this process's hold; safe when we never held it, the lease layer ignores a non-holder.
export async function releaseDockerCleanupLease(): Promise<void> {
  await releaseLease(DOCKER_CLEANUP_LEASE, state.owner);
}

// __stopDockerCleanupScheduler is test-only: stop the loop, drop the lease, reset per-process state.
export async function __stopDockerCleanupScheduler(): Promise<void> {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.ticking = false;
  state.lastFired.clear();
  await releaseLease(DOCKER_CLEANUP_LEASE, state.owner);
}
