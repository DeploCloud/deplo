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
} from "../data/docker-cleanup";

/**
 * The Docker-cleanup scheduler — the thing that makes the stored cron `schedule`
 * actually fire. A SIBLING of the backup scheduler (lib/backups/scheduler.ts):
 * same once-a-minute shape, same lease machinery, its own lease NAME
 * ({@link DOCKER_CLEANUP_LEASE}) so the two loops never block each other. Started
 * once per server boot from `instrumentation.ts` (Node runtime only). Every minute
 * it:
 *
 *  1. claims the cross-process lease, so at most one control-plane instance drives
 *     the sweep (a horizontally-scaled deploy must not run `docker rmi` N times on
 *     the same host); a tick that can't get the lease does nothing this minute,
 *  2. reads the ONE instance-wide policy (there is no per-server schedule) and, if
 *     it is enabled, fans it out over every server that is not excluded, and
 *  3. runs the due ones through {@link runScheduledCleanup} — the session-free
 *     executor entry, which records the same run history as a manual sweep.
 *
 * WHERE IT DIVERGES FROM THE BACKUP SCHEDULER: backups fire on `cronMatches(now)`
 * ALONE, so a minute the lease-holder was down is silently skipped and the run is
 * simply lost until tomorrow. For a nightly hygiene job whose whole purpose is
 * "the disk does not fill up", that is the wrong failure mode — the one night the
 * control plane is restarting is exactly the night the sweep matters. So this
 * scheduler ALSO fires on OVERDUE (see {@link CATCHUP_AFTER_MS}): a host that has
 * not been swept in over a day runs late rather than not at all.
 *
 * Singleton on `globalThis` via `Symbol.for(...)`: Next compiles separate module
 * graphs, and `register()` could import this through more than one, so a
 * module-level flag would start two intervals.
 */

const TICK_MS = 60_000;

/**
 * A host is OVERDUE once its last sweep STARTED more than this long ago — the
 * catch-up predicate, and the reason a 3-day outage does not cost 3 nights of
 * cleanup: the boot tick sees no run inside the window and sweeps immediately
 * instead of waiting for the next cron minute.
 *
 * An hour of slack over the daily period the UI is built around ("0 4 * * *"), so
 * that a run which started at 04:00:30 yesterday is never called overdue at
 * 04:00:00 today — at that minute `cronMatches` is what fires it, and the two
 * predicates should not overlap.
 *
 * A consequence worth stating plainly: this is a FLOOR, so a sparser cron (a
 * weekly `0 4 * * 0`) still gets swept about every 25h. That is deliberate and
 * harmless — WHAT gets reclaimed is bounded by `minAgeHours` and
 * `keepImagesPerApp`, not by how often we look, so a more frequent sweep removes
 * the same objects, just sooner and in smaller bites.
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
 * The servers whose most recent sweep STARTED inside the catch-up window — i.e.
 * the ones that are not overdue. Asked as "who ran recently" rather than "when did
 * each host last run" so the answer needs no aggregate and no per-server query.
 *
 * Deliberately counts a FAILED run as a sweep: an unreachable agent stamps a
 * `failed` run with `startedAt = now`, which takes that host out of the overdue set
 * until the window lapses. Keying off successful runs instead would retry a broken
 * host EVERY MINUTE, burying its history (and the activity feed) under a run row a
 * minute. A host that failed at 04:00 tries again at 04:00 tomorrow, like any other.
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
 * directly. Never throws — one unreachable host is contained so the rest still run.
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
    // one does not recognise). Sweeping with an empty scope set would record a run
    // that reclaimed nothing and call it a success — the exact silent lie the write
    // path exists to prevent.
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
    const inFlight = new Set(running);

    const due = servers.filter((s) => {
      if (excluded.has(s.id)) return false; // the host opted out of the SCHEDULE.
      if (inFlight.has(s.id)) return false; // never stack sweeps on one host.
      if (state.lastFired.get(s.id) === key) return false;
      // A host we have never swept is overdue by construction (it is in no window),
      // so enabling the policy sweeps the fleet promptly rather than leaving the
      // operator to wonder until 04:00 whether it works. The default scopes cannot
      // strand an app, so an unexpected-but-immediate first sweep is safe.
      return onTime || !sweptRecently.has(s.id);
    });

    for (const s of due) {
      // Stamp BEFORE awaiting so a re-entrant/overlapping tick in the same minute
      // can't double-sweep this host even before the run resolves.
      state.lastFired.set(s.id, key);
      try {
        // Unprovisioned hosts are NOT filtered out here on purpose: the executor
        // records "never called home" as a failed run, so a host that is enrolled but
        // never finished provisioning says so in the history instead of vanishing
        // from it. Sequential, like the backup tick: one host's docker at a time.
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
 * Start the once-a-minute cleanup loop. Idempotent — a second call is a no-op, so
 * importing this through more than one Next module graph can't start two loops.
 * Called from `instrumentation.ts` at boot (Node runtime only), AFTER
 * `reconcileInFlightCleanupRuns` has settled any stranded `running` run: the boot
 * tick's never-stack-sweeps check reads those rows, and an unsettled one would
 * exclude its host from the schedule forever.
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
  // Kick an immediate tick: this is where the catch-up predicate earns its keep — a
  // control plane that was down at 04:00 sweeps NOW, at boot, instead of waiting a
  // full day. Floated; its own try/finally contains any failure.
  void runCleanupSchedulerTick();
  console.log("[deplo] docker cleanup scheduler started");
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
