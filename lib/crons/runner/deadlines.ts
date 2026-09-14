import "server-only";

import type { RunRow } from "./targets";

// RETRY_BACKOFF_MS is a FIXED wait, not exponential: a retrying run holds the job's
// `running` slot, so a growing backoff would starve more and more scheduled fires.
export const RETRY_BACKOFF_MS = 60_000;

// REAP_GRACE_MS is the slack past a run's OWN timeout before the control plane stops
// believing it - the agent enforces `timeoutSeconds` itself, unless its timer died.
export const REAP_GRACE_MS = 120_000;

// STALE_CLAIM_MS is how long a run may sit claimed-but-never-launched before the reaper
// writes it off. Only reachable when the control plane stopped between INSERT and StartJob.
export const STALE_CLAIM_MS = 120_000;

// deadlineOf is when the control plane stops believing a run, bounded per ATTEMPT:
// judged from the run's start alone, a retry was killed with most of its timeout unused.
export function deadlineOf(run: RunRow): number {
  const attemptMs = run.timeoutSeconds * 1000 + REAP_GRACE_MS;
  return (
    Date.parse(run.startedAt) +
    (run.attempt + 1) * attemptMs +
    run.attempt * RETRY_BACKOFF_MS
  );
}
