import "server-only";

import { acquireLease, releaseLease, LEASE_STALE_MS } from "../../backups/lease";
import { markerExists, type CutSet } from "./markers";
import type { BackfillDb } from "./types";

/**
 * The per-cut-set backfill gate (relational-store PLAN §7 "Cross-process safety
 * via the scheduler_lease CAS").
 *
 * A cut-set's one-time copy must run AT MOST ONCE across a process — even though
 * a single instance can boot twice (rolling-restart overlap). The existing
 * `scheduler_lease` CAS (`lib/backups/lease.ts`) gives the at-most-once claim, but
 * it is a non-blocking try-once: a loser gets `false` on the same tick. The
 * backfill needs MORE — a loser must BLOCK until the marker exists before its
 * reconcile / scheduler touches the relational tables (else it reads half-copied
 * data), and a long copy must not be stolen mid-flight. This adds the two pieces
 * the bare CAS lacks:
 *
 *  - a **poll-for-marker loop** the loser runs (and can be PROMOTED through if the
 *    winner crashed and the lease goes stale), and
 *  - a **heartbeat** the winner runs so a copy longer than the 2h staleness window
 *    is never reclaimed underneath it.
 *
 * It must NEVER throw out to the request path: `ensureStoreReady` is a
 * single-flight that caches a rejected promise for the life of the process, so a
 * throw here would 500 auth/webhook/agent-bootstrap forever. The caller catches +
 * re-arms (PLAN §8); this function surfaces failure as a return value, not a
 * throw, except for a true reconcile mismatch which the runner raises to force a
 * clean rollback + re-run.
 */

/** Tunables, injectable so tests can drive the loop deterministically. */
export interface GateTiming {
  /** Loser re-checks the marker / retries the lease this often. */
  pollMs: number;
  /** Winner re-acquires the lease this often (must be << {@link LEASE_STALE_MS}). */
  heartbeatMs: number;
  /** Loser gives up waiting after this long (defends against a wedged winner). */
  deadlineMs: number;
}

const DEFAULT_TIMING: GateTiming = {
  pollMs: 1_000,
  // Same magnitude as the scheduler's 60s tick — comfortably under the 2h window.
  heartbeatMs: 30_000,
  // A copy that hasn't finished within the staleness window plus slack is wedged;
  // the loser stops blocking rather than spinning forever.
  deadlineMs: LEASE_STALE_MS + 5 * 60_000,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `runner` (a cut-set's copy + reconcile + marker write, all in one tx)
 * exactly once across the process, holding the lease and heartbeating for the
 * duration so the claim can't be stolen mid-flight.
 */
async function runAsWinner(
  leaseName: string,
  owner: string,
  runner: () => Promise<void>,
  timing: GateTiming,
): Promise<void> {
  const heartbeat = setInterval(() => {
    // Idempotent renew for the current owner — advances `heartbeat_at` so a loser's
    // stale check never fires while the copy is in progress. Best-effort: a blip
    // here just risks an early steal, which the marker check still guards against.
    void acquireLease(leaseName, owner).catch(() => {});
  }, timing.heartbeatMs);
  try {
    await runner();
  } finally {
    clearInterval(heartbeat);
    await releaseLease(leaseName, owner);
  }
}

/**
 * Ensure the named cut-set's backfill has run before returning. Idempotent and
 * safe under concurrent callers / a double-boot.
 *
 *  - Fast path: marker present ⇒ return immediately (no lease).
 *  - Winner (CAS true): run `runner` under a heartbeat, then return.
 *  - Loser (CAS false): block — poll for the marker, and if the winner crashed
 *    (its lease goes stale) the loser is promoted and runs `runner` itself.
 *
 * A reconcile mismatch inside `runner` propagates (the caller wants the throw so
 * the marker is NOT written and the next boot re-runs from the still-live JSONB).
 * A lease/DB blip is swallowed as "keep waiting".
 */
export async function awaitBackfill(
  db: BackfillDb,
  cutSet: CutSet,
  owner: string,
  runner: () => Promise<void>,
  timing: GateTiming = DEFAULT_TIMING,
): Promise<void> {
  if (await markerExists(db, cutSet)) return;

  const leaseName = `backfill-${cutSet}`;
  const start = Date.now();

  // First claim attempt — winner runs immediately.
  if (await acquireLease(leaseName, owner)) {
    await runAsWinner(leaseName, owner, runner, timing);
    return;
  }

  // Loser: block until the marker appears, or until we can be promoted (the prior
  // winner crashed and its lease went stale), or until the deadline.
  while (Date.now() - start < timing.deadlineMs) {
    await sleep(timing.pollMs);
    if (await markerExists(db, cutSet)) return;
    // Re-try the CAS: succeeds only if the prior holder released (clean finish
    // with no marker — shouldn't happen, but harmless) or its lease went stale
    // (crash). Either way we promote ourselves and run the copy.
    if (await acquireLease(leaseName, owner)) {
      // Re-check the marker now that we hold the lease, to avoid a redundant copy
      // if the winner committed between our last check and the steal.
      if (await markerExists(db, cutSet)) {
        await releaseLease(leaseName, owner);
        return;
      }
      await runAsWinner(leaseName, owner, runner, timing);
      return;
    }
  }

  // Deadline hit: stop blocking. The caller's re-arm means the NEXT
  // ensureStoreReady re-attempts; we do not throw (a throw would 500 the process).
  console.warn(
    `[backfill] gate for ${cutSet} timed out waiting for the marker; will retry on the next ensureStoreReady`,
  );
}
