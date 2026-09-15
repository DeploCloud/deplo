import "server-only";

import type { RunRow } from "./targets";

export const RETRY_BACKOFF_MS = 60_000;

export const REAP_GRACE_MS = 120_000;

export const STALE_CLAIM_MS = 120_000;

export function deadlineOf(run: RunRow): number {
  const attemptMs = run.timeoutSeconds * 1000 + REAP_GRACE_MS;
  return (
    Date.parse(run.startedAt) +
    (run.attempt + 1) * attemptMs +
    run.attempt * RETRY_BACKOFF_MS
  );
}
