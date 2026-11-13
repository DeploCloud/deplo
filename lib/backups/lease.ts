import "server-only";

import { existsSync } from "node:fs";
import { hostname } from "node:os";

import { getPool, isPostgresEnabled } from "../db/pg";

export const LEASE_STALE_MS = 2 * 60 * 60 * 1000;

export const BACKUP_SCHEDULER_LEASE = "backup-scheduler";

export const DOCKER_CLEANUP_LEASE = "docker-cleanup-scheduler";

export const PREVIEW_REAPER_LEASE = "preview-reaper";

export const CRON_SCHEDULER_LEASE = "cron-scheduler";

export const SECURITY_UPDATES_LEASE = "security-updates";

export const AUTO_UPDATE_LEASE = "auto-updates";

export interface LeaseRow {
  owner: string;
  heartbeatAt: Date;
}

export function canAcquire(
  existing: LeaseRow | null,
  me: string,
  now: Date,
  staleMs: number = LEASE_STALE_MS,
): boolean {
  if (!existing) return true;
  if (existing.owner === me) return true;
  return now.getTime() - existing.heartbeatAt.getTime() > staleMs;
}

interface ProcessProbe {
  host: string;
  alive: (pid: number) => boolean;
  /** This process, which a restarted container runs under the same host and pid as the one before it. */
  pid?: number;
  startedAt?: number;
}

function thisProcess(): ProcessProbe {
  return {
    host: hostname(),
    alive: (pid) => existsSync(`/proc/${pid}`),
    pid: process.pid,
    startedAt: Date.now() - process.uptime() * 1000,
  };
}

export function ownedByDeadLocalProcess(
  owner: string,
  probe: ProcessProbe = thisProcess(),
  heartbeatAt?: Date,
): boolean {
  const [host, pid] = owner.split(":");
  if (host !== probe.host) return false;
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  // Our own pid, last heard from before we started: the run before a container restart.
  if (n === probe.pid && heartbeatAt && probe.startedAt !== undefined)
    return heartbeatAt.getTime() < probe.startedAt;
  return !probe.alive(n);
}

type LocalLeases = Map<string, LeaseRow>;
const LOCAL_KEY = Symbol.for("deplo.backup.scheduler.lease.local");
const g = globalThis as unknown as { [LOCAL_KEY]?: LocalLeases };
const localLeases: LocalLeases = (g[LOCAL_KEY] ??= new Map());

function acquireLocal(
  name: string,
  owner: string,
  now: Date,
  staleMs: number,
): boolean {
  const existing = localLeases.get(name) ?? null;
  if (!canAcquire(existing, owner, now, staleMs)) return false;
  localLeases.set(name, { owner, heartbeatAt: now });
  return true;
}

function releaseLocal(name: string, owner: string): void {
  if (localLeases.get(name)?.owner === owner) localLeases.delete(name);
}

async function acquirePostgres(
  name: string,
  owner: string,
  staleMs: number,
): Promise<boolean> {
  const staleSeconds = Math.floor(staleMs / 1000);
  const res = await getPool().query<{ owner: string }>(
    `INSERT INTO scheduler_lease (name, owner, heartbeat_at, acquired_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (name) DO UPDATE
       SET owner = EXCLUDED.owner,
           heartbeat_at = now(),
           acquired_at = CASE
             WHEN scheduler_lease.owner = EXCLUDED.owner THEN scheduler_lease.acquired_at
             ELSE now()
           END
       WHERE scheduler_lease.owner = EXCLUDED.owner
          OR scheduler_lease.heartbeat_at < now() - make_interval(secs => $3)
     RETURNING owner`,
    [name, owner, staleSeconds],
  );
  return res.rows[0]?.owner === owner;
}

async function releasePostgres(name: string, owner: string): Promise<void> {
  await getPool().query(
    `DELETE FROM scheduler_lease WHERE name = $1 AND owner = $2`,
    [name, owner],
  );
}

const STOPPING_KEY = Symbol.for("deplo.scheduler.lease.stopping");
const gs = globalThis as unknown as { [STOPPING_KEY]?: boolean };

// On shutdown: a tick that renews after the release would hold its lease for 2h.
export function stopAcquiringLeases(): void {
  gs[STOPPING_KEY] = true;
}

export async function acquireLease(
  name: string,
  owner: string,
  now: Date = new Date(),
  staleMs: number = LEASE_STALE_MS,
): Promise<boolean> {
  if (gs[STOPPING_KEY]) return false;
  const held = await acquireNow(name, owner, now, staleMs);
  // Sent before shutdown began, landed after its release.
  if (held && gs[STOPPING_KEY]) {
    await releaseLease(name, owner);
    return false;
  }
  return held;
}

async function acquireNow(
  name: string,
  owner: string,
  now: Date,
  staleMs: number,
): Promise<boolean> {
  if (!isPostgresEnabled()) return acquireLocal(name, owner, now, staleMs);
  try {
    if (await acquirePostgres(name, owner, staleMs)) return true;
    const held = await getPool().query<{ owner: string; heartbeat_at: Date }>(
      `SELECT owner, heartbeat_at FROM scheduler_lease WHERE name = $1`,
      [name],
    );
    const row = held.rows[0];
    const holder = row?.owner;
    if (
      !holder ||
      !ownedByDeadLocalProcess(holder, undefined, new Date(row.heartbeat_at))
    )
      return false;
    await releasePostgres(name, holder);
    return await acquirePostgres(name, owner, staleMs);
  } catch (e) {
    console.warn(
      `[backups] scheduler lease acquire failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

export async function releaseLease(name: string, owner: string): Promise<void> {
  if (!isPostgresEnabled()) {
    releaseLocal(name, owner);
    return;
  }
  try {
    await releasePostgres(name, owner);
  } catch (e) {
    console.warn(
      `[backups] scheduler lease release failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function __resetLocalLeases(): void {
  localLeases.clear();
}
