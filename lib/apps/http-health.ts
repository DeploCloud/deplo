// https://deplo.build/docs/guides/observability/monitoring

/**
 * An HTTP health check is asked by DEPLO, through the agent, not by a
 * `healthcheck:` in the stack. A compose probe has to run a command inside the
 * image, and the images most people deploy (Railpack's output, distroless,
 * `traefik/whoami`) have neither curl nor wget, so the container sat unhealthy
 * for ever - and Traefik drops an unhealthy container, which took the app off
 * the internet. Asking from outside works on any image and never touches routing.
 */

/** Per app, in memory: the same place metrics history lives. */
const state = new Map<
  string,
  { failures: number; verdict: "healthy" | "unhealthy"; at: number }
>();

/**
 * Docker's own rule: a check stays healthy until `retries` consecutive failures.
 * A success forgets the streak.
 */
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

/**
 * The verdict already taken, when the check's own interval has not elapsed. The
 * runtime read is polled by every open page, and `Interval` is the field that
 * says how often the app should actually be asked.
 */
export function recentHttpHealth(
  appId: string,
  intervalS: number,
  now = Date.now(),
): "healthy" | "unhealthy" | null {
  const seen = state.get(appId);
  if (!seen || intervalS <= 0) return null;
  return now - seen.at < intervalS * 1000 ? seen.verdict : null;
}

/** Forget an app's streak - it stopped, moved, or was deleted. */
export function forgetHttpHealth(appId: string): void {
  state.delete(appId);
}

/**
 * Is this container still inside its start period? Before it is up, a failing
 * probe is the app booting, and Docker calls that `starting` rather than a
 * failure. `startedAtUnix` of 0 means the agent did not say, so we do not guess.
 */
export function withinStartPeriod(
  startedAtUnix: number,
  startPeriodS: number,
  now = Date.now(),
): boolean {
  if (!startedAtUnix || startPeriodS <= 0) return false;
  return now / 1000 - startedAtUnix < startPeriodS;
}
