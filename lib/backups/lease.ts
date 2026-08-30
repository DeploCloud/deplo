import "server-only";

import { getPool, isPostgresEnabled } from "../db/pg";

/**
 * Cross-process lease for the backup scheduler (Step 6). Why a lease at all: a due
 * backup must fire AT MOST ONCE. Without a shared mutex each instance would dump
 * the same database to S3 simultaneously.
 */

/** A lease is reclaimable once its heartbeat is older than this. */
export const LEASE_STALE_MS = 2 * 60 * 60 * 1000; // 2h - see PLAN "stale > 2h".

/** The scheduler's lease name (one row in `scheduler_lease`). */
export const BACKUP_SCHEDULER_LEASE = "backup-scheduler";

/**
 * The Docker-cleanup scheduler's lease name.
 */
export const DOCKER_CLEANUP_LEASE = "docker-cleanup-scheduler";

/**
 * The pull request preview reaper's lease name. A third independent row, for the
 * same reason as the second: the three loops claim different names, so a long
 * nightly dump can never block a preview from being reaped (or the reverse).
 */
export const PREVIEW_REAPER_LEASE = "preview-reaper";

/**
 * The cron scheduler's lease name - a fourth row, same reasoning again.
 */
export const CRON_SCHEDULER_LEASE = "cron-scheduler";

/* ------------------------------------------------------------------ */
/* Pure decision (unit-tested)                                          */
/* ------------------------------------------------------------------ */

/** The current lease row as seen by a claimant (null = no row yet). */
export interface LeaseRow {
  owner: string;
  heartbeatAt: Date;
}

/**
 * Pure CAS decision: given the existing lease row (or null), can `me` take/keep it
 * as of `now`?
 */
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

/* ------------------------------------------------------------------ */
/* In-process fallback (no Postgres)                                    */
/* ------------------------------------------------------------------ */

type LocalLeases = Map<string, LeaseRow>;
const LOCAL_KEY = Symbol.for("deplo.backup.scheduler.lease.local");
const g = globalThis as unknown as { [LOCAL_KEY]?: LocalLeases };
// Same globalThis-singleton rationale as the store: RSC and route-handler graphs
// are separate module registries, so a module-level Map would split the lock.
const localLeases: LocalLeases = (g[LOCAL_KEY] ??= new Map());

function acquireLocal(
  name: string,
  owner: string,
  now: Date,
  staleMs: number,
): boolean {
  const existing = localLeases.get(name) ?? null;
  // The window comes from the CALLER, exactly as it does in the SQL above: a holder
  // that wants a tighter one (the migration runner does) must get the same answer
  // from both paths, or the fallback tests a rule production is not running.
  if (!canAcquire(existing, owner, now, staleMs)) return false;
  localLeases.set(name, { owner, heartbeatAt: now });
  return true;
}

function releaseLocal(name: string, owner: string): void {
  if (localLeases.get(name)?.owner === owner) localLeases.delete(name);
}

/* ------------------------------------------------------------------ */
/* Postgres CAS                                                         */
/* ------------------------------------------------------------------ */

/**
 * Atomically claim or renew the lease in Postgres.
 */
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
  // A row comes back only when WE hold it (insert, renew, or steal). If a live
  // foreign owner blocked the update, ON CONFLICT's WHERE failed → 0 rows.
  return res.rows[0]?.owner === owner;
}

async function releasePostgres(name: string, owner: string): Promise<void> {
  // Only the holder releases - a stale-steal by someone else must not be undone.
  await getPool().query(
    `DELETE FROM scheduler_lease WHERE name = $1 AND owner = $2`,
    [name, owner],
  );
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Claim or renew `name` for `owner`. Returns true if we hold it after the call.
 */
export async function acquireLease(
  name: string,
  owner: string,
  now: Date = new Date(),
  staleMs: number = LEASE_STALE_MS,
): Promise<boolean> {
  if (!isPostgresEnabled()) return acquireLocal(name, owner, now, staleMs);
  try {
    return await acquirePostgres(name, owner, staleMs);
  } catch (e) {
    console.warn(
      `[backups] scheduler lease acquire failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/** Release `name` if `owner` still holds it. Best-effort; never throws. */
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

/** Test-only: reset the in-process lease map between cases. */
export function __resetLocalLeases(): void {
  localLeases.clear();
}
