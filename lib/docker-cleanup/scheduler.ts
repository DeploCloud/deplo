import "server-only";

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import { gte } from "drizzle-orm";

import { getDb } from "../db/client";
import { dockerCleanupRuns } from "../db/schema/control-plane";
import { cronMatches } from "../backups/cron";
import {
  acquireLease,
  releaseLease,
  DOCKER_CLEANUP_LEASE,
} from "../backups/lease";
import { listAllServers } from "../data/servers";
import {
  listServersWithCleanupRunning,
  loadCleanupPolicyForScheduler,
  runScheduledCleanup,
  serversWithDeploySweepInFlight,
} from "../data/docker-cleanup";

/**
 * The Docker-cleanup scheduler - the thing that makes the stored cron `schedule`
 * actually fire.
 */

const TICK_MS = 60_000;

/**
 * A host is OVERDUE once its last sweep STARTED more than this long ago - the
 * catch-up predicate, and the reason a 3-day outage does not cost 3 nights of
 * cleanup: the boot tick sees no run inside the window and sweeps immediately
 */
const CATCHUP_AFTER_MS = 25 * 60 * 60_000;

/** A label identifying THIS process as the lease owner across restarts. */
function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  /** Guards against sweeping one server twice within the same wall-clock minute
   *  (overlapping ticks / drift): serverId → the minute key we last fired it for. */
  lastFired: Map<string, string>;
  /** True while a tick is in flight, so a slow tick never overlaps the next. */
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

/** Minute-precision key for the dedup guard, e.g. "2026-07-14T04:00". */
function minuteKey(at: Date): string {
  return at.toISOString().slice(0, 16);
}

/**
 * The servers whose most recent sweep STARTED inside the catch-up window - i.e.
 * the ones that are not overdue.
 */
async function listServersSweptSince(cutoff: Date): Promise<Set<string>> {
  const rows = await getDb()
    .select({ serverId: dockerCleanupRuns.serverId })
    .from(dockerCleanupRuns)
    .where(gte(dockerCleanupRuns.startedAt, cutoff.toISOString()));
  return new Set(
    rows.map((r) => r.serverId).filter((id): id is string => id !== null),
  );
}

/**
 * One scheduler tick: claim the lease, then sweep every server the enabled policy
 * is due on this minute. Exported for tests + an immediate first run; safe to call
 * directly. Never throws - one unreachable host is contained so the rest still run.
 */
export async function runCleanupSchedulerTick(
  now: Date = new Date(),
): Promise<void> {
  if (state.ticking) return; // a previous tick is still draining; skip this one.
  state.ticking = true;
  try {
    // Lease first: no point reading/evaluating if another instance owns the tick.
    const held = await acquireLease(DOCKER_CLEANUP_LEASE, state.owner, now);
    if (!held) return;

    const policy = await loadCleanupPolicyForScheduler();
    if (!policy.enabled) return;
    // `updateCleanupPolicy` refuses to enable a policy with no scopes, so this only
    // catches the downgrade case (a policy written by a newer build whose scopes this
    // one does not recognise).
    if (policy.scopes.length === 0) return;

    const key = minuteKey(now);
    // Evaluate the cron ONCE: the policy is instance-wide, so "is this the minute?"
    // is the same question for every server, and only OVERDUE is decided per host.
    const onTime = cronMatches(policy.schedule, now);
    const [servers, running, sweptRecently] = await Promise.all([
      listAllServers(),
      listServersWithCleanupRunning(),
      listServersSweptSince(new Date(now.getTime() - CATCHUP_AFTER_MS)),
    ]);
    const excluded = new Set(policy.excludedServerIds);
    // Recorded `running` rows AND the history-silent deploy-time sweeps: both are a
    // sweep already touching that host's images, and stacking a second one only
    // makes the two race each other's candidate lists.
    const inFlight = new Set([...running, ...serversWithDeploySweepInFlight()]);

    const due = servers.filter((s) => {
      // A migration source is another platform's live host: reclaiming disk there would
      // delete THEIR images and build cache, off a schedule they never set.
      if (s.importOnly) return false;
      if (excluded.has(s.id)) return false; // the host opted out of the SCHEDULE.
      if (inFlight.has(s.id)) return false; // never stack sweeps on one host.
      if (state.lastFired.get(s.id) === key) return false;
      // A host we have never swept is overdue by construction (it is in no window), so
      // enabling the policy sweeps the fleet promptly rather than leaving the operator to
      // wonder until 04:00 whether it works.
      return onTime || !sweptRecently.has(s.id);
    });

    for (const s of due) {
      // Heartbeat mid-drain: a fleet's worth of sequential sweeps can outlast
      // LEASE_STALE_MS, and a lease whose heartbeat only advances at tick start would go
      // stale - free for another instance to steal and double-sweep.
      if (!(await acquireLease(DOCKER_CLEANUP_LEASE, state.owner))) break;
      // Stamp BEFORE awaiting so a re-entrant/overlapping tick in the same minute
      // can't double-sweep this host even before the run resolves.
      state.lastFired.set(s.id, key);
      try {
        // Unprovisioned hosts are NOT filtered out here on purpose: the executor records
        // "never called home" as a failed run, so a host that is enrolled but never
        // finished provisioning says so in the history instead of vanishing from it.
        await runScheduledCleanup(s.id, s.name, policy);
      } catch (e) {
        // runScheduledCleanup already swallows + records; this is belt-and-braces.
        console.warn(
          `[cleanup] scheduled cleanup on ${s.name} errored: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Bound the dedup map: drop entries for minutes other than the current one (a
    // host is swept at most once a minute, so older keys are dead weight).
    for (const [id, k] of state.lastFired) {
      if (k !== key) state.lastFired.delete(id);
    }
  } finally {
    state.ticking = false;
  }
}

/**
 * Start the once-a-minute cleanup loop. Idempotent - a second call is a no-op, so
 * importing this through more than one Next module graph can't start two loops.
 */
export function startDockerCleanupScheduler(): void {
  if (state.started) return;
  state.started = true;
  // `unref()` so the interval never keeps the process alive on its own (it rides the
  // server's lifetime; an idle CLI/script wouldn't be pinned open by it).
  const timer = setInterval(() => {
    void runCleanupSchedulerTick();
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
  // Kick an immediate tick: this is where the catch-up predicate earns its keep - a
  // control plane that was down at 04:00 sweeps NOW, at boot, instead of waiting a
  // full day. Floated; its own try/finally contains any failure.
  void runCleanupSchedulerTick();
  console.log("[deplo] docker cleanup scheduler started");
}

/**
 * Release this process's hold on the cleanup lease. Best-effort and safe when we
 * never held it - the lease layer ignores a release by a non-holder.
 */
export async function releaseDockerCleanupLease(): Promise<void> {
  await releaseLease(DOCKER_CLEANUP_LEASE, state.owner);
}

/** Test-only: stop the loop, drop the lease, and reset the per-process state. */
export async function __stopDockerCleanupScheduler(): Promise<void> {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.ticking = false;
  state.lastFired.clear();
  await releaseLease(DOCKER_CLEANUP_LEASE, state.owner);
}
