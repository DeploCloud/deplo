import "server-only";

import { alertConfigForTeam } from "../data/notifications";
import { publicBaseUrl } from "../public-url";
import { sendToChannel } from "./channels";
import { shouldFire } from "./cooldown";
import { teamsForServerAlerts } from "./server-teams";
import type { AlertKey } from "../types";

/**
 * The one way anything in Deplo tells a team something happened.
 *
 * `teamId` is ALWAYS a parameter and never read from the request context: most
 * alerts are raised by a deploy runner, a scheduler tick or a telemetry stream,
 * none of which has an active team or a user. Reaching for AsyncLocalStorage
 * here would return null exactly when it matters.
 *
 * Fire-and-forget by default, and that is deliberate. `recordActivity` is
 * awaited because it is a ~1ms local INSERT that must stay inside the request's
 * connection lifetime; an alert is up to six outbound HTTPS POSTs to third
 * parties. Awaiting it inside `commitOutcome` would put a stranger's latency
 * inside every deploy, and inside `recordServerHealth` it would land inside the
 * 8s heartbeat that is tuned to stay under the health throttle.
 */

export interface Alert {
  teamId: string;
  key: AlertKey;
  /** One line: what happened, to what. */
  title: string;
  /** One or two lines: the actionable detail. */
  body: string;
  /** Dashboard path (`/apps/api`), made absolute if the panel URL is known. */
  path?: string;
  /**
   * Identity + current state of a REPEATED condition, e.g.
   * `{ id: "server:srv_1", state: "offline" }`. Omit for one-shot events.
   */
  dedupe?: { id: string; state: string };
}

/** How long one channel gets before the others stop waiting for it. */
export const CHANNEL_TIMEOUT_MS = 5_000;

/** Raise an alert. Never throws, never blocks the caller. THE default. */
export function dispatchAlert(alert: Alert): void {
  void dispatchAlertNow(alert).catch((e) =>
    console.error("[deplo] alert dispatch failed:", e),
  );
}

/** The awaited variant, for tests and for a caller that genuinely wants to wait. */
export async function dispatchAlertNow(alert: Alert): Promise<void> {
  try {
    // Dedupe FIRST: a suppressed alert must cost zero queries.
    if (alert.dedupe && !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state))
      return;
    const cfg = await alertConfigForTeam(alert.teamId);
    if (!cfg.wants(alert.key) || cfg.channels.length === 0) return;

    const base = publicBaseUrl();
    const msg = {
      key: alert.key,
      title: alert.title,
      body: alert.body,
      url: alert.path && base ? `${base}${alert.path}` : null,
      ts: new Date().toISOString(),
    };
    // allSettled: a dead Discord webhook must not cost the email.
    const results = await Promise.allSettled(
      cfg.channels.map((c) =>
        sendToChannel(c, msg, AbortSignal.timeout(CHANNEL_TIMEOUT_MS)),
      ),
    );
    for (const r of results)
      if (r.status === "rejected")
        console.error("[deplo] alert channel failed:", r.reason);
  } catch (e) {
    console.error("[deplo] alert dispatch failed:", e);
  }
}

/**
 * Raise a SERVER-level alert. Servers are the one cross-team resource, so the
 * same event reaches every team that has something running on the host.
 *
 * The dedupe is evaluated ONCE, on the server, before the team lookup: ten teams
 * get one alert each per transition, and the steady state stays a `Map.get`.
 */
export function dispatchServerAlert(
  serverId: string,
  alert: Omit<Alert, "teamId">,
): void {
  if (alert.dedupe && !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state))
    return;
  void (async () => {
    for (const teamId of await teamsForServerAlerts(serverId))
      await dispatchAlertNow({ ...alert, teamId, dedupe: undefined });
  })().catch((e) => console.error("[deplo] server alert fan-out failed:", e));
}

/** Raise the same alert for several teams at once (a fleet-wide condition). */
export function dispatchToTeams(
  teamIds: string[],
  alert: Omit<Alert, "teamId">,
): void {
  if (alert.dedupe && !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state))
    return;
  void (async () => {
    for (const teamId of teamIds)
      await dispatchAlertNow({ ...alert, teamId, dedupe: undefined });
  })().catch((e) => console.error("[deplo] alert fan-out failed:", e));
}
