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

const CATCHUP_AFTER_MS = 25 * 60 * 60_000;

function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  lastFired: Map<string, string>;
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

export async function runCleanupSchedulerTick(
  now: Date = new Date(),
): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const held = await acquireLease(DOCKER_CLEANUP_LEASE, state.owner, now);
    if (!held) return;

    const policy = await loadCleanupPolicyForScheduler();
    if (!policy.enabled) return;
    if (policy.scopes.length === 0) return;

    const key = minuteKey(now);
    const onTime = cronMatches(policy.schedule, now);
    const [servers, running, sweptRecently] = await Promise.all([
      listAllServers(),
      listServersWithCleanupRunning(),
      listServersSweptSince(new Date(now.getTime() - CATCHUP_AFTER_MS)),
    ]);
    const excluded = new Set(policy.excludedServerIds);
    const inFlight = new Set([...running, ...serversWithDeploySweepInFlight()]);

    const due = servers.filter((s) => {
      if (s.importOnly) return false;
      if (excluded.has(s.id)) return false;
      if (inFlight.has(s.id)) return false;
      if (state.lastFired.get(s.id) === key) return false;
      return onTime || !sweptRecently.has(s.id);
    });

    for (const s of due) {
      if (!(await acquireLease(DOCKER_CLEANUP_LEASE, state.owner))) break;
      state.lastFired.set(s.id, key);
      try {
        await runScheduledCleanup(s.id, s.name, policy);
      } catch (e) {
        console.warn(
          `[cleanup] scheduled cleanup on ${s.name} errored: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    for (const [id, k] of state.lastFired) {
      if (k !== key) state.lastFired.delete(id);
    }
  } finally {
    state.ticking = false;
  }
}

export function startDockerCleanupScheduler(): void {
  if (state.started) return;
  state.started = true;
  const timer = setInterval(() => {
    void runCleanupSchedulerTick();
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
  void runCleanupSchedulerTick();
  console.log("[deplo] docker cleanup scheduler started");
}

export async function releaseDockerCleanupLease(): Promise<void> {
  await releaseLease(DOCKER_CLEANUP_LEASE, state.owner);
}

export async function __stopDockerCleanupScheduler(): Promise<void> {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.ticking = false;
  state.lastFired.clear();
  await releaseLease(DOCKER_CLEANUP_LEASE, state.owner);
}
