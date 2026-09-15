import "server-only";

import { existsSync } from "node:fs";
import { hostname } from "node:os";

import { getPool, isPostgresEnabled } from "../db/pg";

export const LEASE_STALE_MS = 2 * 60 * 60 * 1000;

export const BACKUP_SCHEDULER_LEASE = "backup-scheduler";

export const DOCKER_CLEANUP_LEASE = "docker-cleanup-scheduler";

export const PREVIEW_REAPER_LEASE = "preview-reaper";

export const CRON_SCHEDULER_LEASE = "cron-scheduler";

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

export function ownedByDeadLocalProcess(
  owner: string,
  probe: { host: string; alive: (pid: number) => boolean } = {
    host: hostname(),
    alive: (pid) => existsSync(`/proc/${pid}`),
  },
): boolean {
  const [host, pid] = owner.split(":");
  if (host !== probe.host) return false;
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
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

export async function acquireLease(
  name: string,
  owner: string,
  now: Date = new Date(),
  staleMs: number = LEASE_STALE_MS,
): Promise<boolean> {
  if (!isPostgresEnabled()) return acquireLocal(name, owner, now, staleMs);
  try {
    if (await acquirePostgres(name, owner, staleMs)) return true;
    const held = await getPool().query<{ owner: string }>(
      `SELECT owner FROM scheduler_lease WHERE name = $1`,
      [name],
    );
    const holder = held.rows[0]?.owner;
    if (!holder || !ownedByDeadLocalProcess(holder)) return false;
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
