// https://deplo.build/docs/guides/observability/monitoring

const state = new Map<
  string,
  { failures: number; verdict: "healthy" | "unhealthy"; at: number }
>();

// httpHealthVerdict follows Docker's rule: unhealthy only after `retries` consecutive failures.
export function httpHealthVerdict(
  appId: string,
  ok: boolean,
  retries: number,
  now = Date.now(),
): "healthy" | "unhealthy" {
  const failures = ok ? 0 : (state.get(appId)?.failures ?? 0) + 1;
  const verdict =
    !ok && failures >= Math.max(1, retries) ? "unhealthy" : "healthy";
  state.set(appId, { failures, verdict, at: now });
  return verdict;
}

// recentHttpHealth is the verdict already taken, while the check's interval has not elapsed.
export function recentHttpHealth(
  appId: string,
  intervalS: number,
  now = Date.now(),
): "healthy" | "unhealthy" | null {
  const seen = state.get(appId);
  if (!seen || intervalS <= 0) return null;
  return now - seen.at < intervalS * 1000 ? seen.verdict : null;
}

// forgetHttpHealth forgets an app's streak - it stopped, moved, or was deleted.
export function forgetHttpHealth(appId: string): void {
  state.delete(appId);
}

// withinStartPeriod reports whether this container is still inside its start period.
export function withinStartPeriod(
  startedAtUnix: number,
  startPeriodS: number,
  now = Date.now(),
): boolean {
  if (!startedAtUnix || startPeriodS <= 0) return false;
  return now / 1000 - startedAtUnix < startPeriodS;
}
