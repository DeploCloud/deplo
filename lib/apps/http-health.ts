const state = new Map<
  string,
  { failures: number; verdict: "healthy" | "unhealthy"; at: number }
>();

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

export function recentHttpHealth(
  appId: string,
  intervalS: number,
  now = Date.now(),
): "healthy" | "unhealthy" | null {
  const seen = state.get(appId);
  if (!seen || intervalS <= 0) return null;
  return now - seen.at < intervalS * 1000 ? seen.verdict : null;
}

export function forgetHttpHealth(appId: string): void {
  state.delete(appId);
}

export function withinStartPeriod(
  startedAtUnix: number,
  startPeriodS: number,
  now = Date.now(),
): boolean {
  if (!startedAtUnix || startPeriodS <= 0) return false;
  return now / 1000 - startedAtUnix < startPeriodS;
}
