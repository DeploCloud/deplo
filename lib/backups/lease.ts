import "server-only";

import { getPool, isPostgresEnabled } from "../db/pg";

/**
 * Cross-process lease for the backup scheduler (Step 6).
 *
 * Why a lease at all: a due backup must fire AT MOST ONCE. The scheduler ticks
 * once a minute in every control-plane instance, and a horizontally-scaled
 * deploy runs several. Without a shared mutex each instance would dump the same
 * database to S3 simultaneously. The JSONB document store can't provide a real
 * cross-process lock (a whole-document write races), so this is the ONE
 * relational addition (Step 1): a `scheduler_lease` row claimed by an atomic CAS.
 *
 * Crash recovery: the owner heartbeats while it holds the lease; a lease whose
 * heartbeat is older than the staleness window is considered crashed and may be
 * STOLEN by another instance — so a dead owner never blocks the schedule forever.
 *
 * Test-only in-memory mode (no Postgres): the lock degrades to an in-process
 * `globalThis` singleton — a real mutex within the one process. This path is
 * exercised by the scheduler/lease tests; every real run is Postgres-backed.
 */

/** A lease is reclaimable once its heartbeat is older than this. */
export const LEASE_STALE_MS = 2 * 60 * 60 * 1000; // 2h — see PLAN "stale > 2h".

/** The scheduler's lease name (one row in `scheduler_lease`). */
export const BACKUP_SCHEDULER_LEASE = "backup-scheduler";

/* ------------------------------------------------------------------ */
/* Pure decision (unit-tested)                                          */
/* ------------------------------------------------------------------ */

/** The current lease row as seen by a claimant (null = no row yet). */
export interface LeaseRow {
  owner: string;
  heartbeatAt: Date;
}

/**
 * Pure CAS decision: given the existing lease row (or null), can `me` take/keep
 * it as of `now`? Mirrors the SQL the Postgres path runs, so the rule is tested
 * once here and the DB path just executes it atomically.
 *
 * - No row → claim (a fresh lease).
 * - We already own it → renew (keep + heartbeat).
 * - Someone else owns it but their heartbeat is stale → steal.
 * - Someone else owns it and is alive → deny.
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

function acquireLocal(name: string, owner: string, now: Date): boolean {
  const existing = localLeases.get(name) ?? null;
  if (!canAcquire(existing, owner, now)) return false;
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
 * Atomically claim or renew the lease in Postgres. The single `INSERT … ON
 * CONFLICT DO UPDATE … WHERE` does the whole CAS server-side, so two instances
 * racing the same tick can never both win: the conflicting update only fires when
 * the existing row is ours OR stale, and `RETURNING` tells us whether our row
 * stands. `acquired_at` advances only on a true (re-)acquisition, not a renew.
 *
 * Table creation is owned by the Drizzle migrations (`scheduler_lease` is declared
 * in `schema/scheduler.ts` as `timestamptz`). The old on-demand `CREATE TABLE IF
 * NOT EXISTS` was removed in relational-store Step 0 so a single regime owns the
 * schema (PLAN §8). The staleness comparison is server-side against `now()`, so
 * the column tz is correctness-neutral for the CAS itself.
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
  // Only the holder releases — a stale-steal by someone else must not be undone.
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
 * Idempotent for the current holder (acts as the heartbeat). Postgres-backed
 * when configured, else the in-process fallback. A Postgres error is treated as
 * "not acquired" (logged) so a transient DB blip skips the tick rather than
 * letting an unguarded backup fire.
 */
export async function acquireLease(
  name: string,
  owner: string,
  now: Date = new Date(),
  staleMs: number = LEASE_STALE_MS,
): Promise<boolean> {
  if (!isPostgresEnabled()) return acquireLocal(name, owner, now);
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
