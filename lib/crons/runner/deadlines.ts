import "server-only";

import type { RunRow } from "./targets";

// Fixed, not exponential: a retrying run holds the job's running slot, so a growing wait starves scheduled fires.
export const RETRY_BACKOFF_MS = 60_000;

export const REAP_GRACE_MS = 120_000;

export const STALE_CLAIM_MS = 120_000;

// Bounded per ATTEMPT: judged from the run's start alone, a retry was killed with most of its timeout unused.
export function deadlineOf(run: RunRow): number {
  const attemptMs = run.timeoutSeconds * 1000 + REAP_GRACE_MS;
  return (
    Date.parse(run.startedAt) +
    (run.attempt + 1) * attemptMs +
    run.attempt * RETRY_BACKOFF_MS
  );
}
