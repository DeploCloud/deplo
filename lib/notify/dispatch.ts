import "server-only";

// https://deplo.build/docs/guides/observability/notifications-and-alerts

import { channelsForAlert } from "../data/notifications";
import { teamSlugById } from "../data/teams";
import { withTeam } from "../team-path";
import { publicBaseUrl } from "../public-url";
import { CHANNEL_TIMEOUT_MS, sendToChannel } from "./channels";
import { shouldFire } from "./cooldown";
import { teamsForServerAlerts } from "./server-teams";
import type { AlertKey } from "../types";

/**
 * The one way anything in Deplo tells a team something happened. Reaching for
 * AsyncLocalStorage here would return null exactly when it matters.
 */

export interface Alert {
  teamId: string;
  key: AlertKey;
  /** One line: what happened, to what. */
  title: string;
  /** One or two lines: the actionable detail. */
  body: string;
  /**
   * Dashboard path, written FLAT (`/apps/api`): the team is put on it and the
   * panel's address in front of it, so the link opens in the right team for
   * whoever clicks it, whatever team their browser last had.
   */
  path?: string;
  /**
   * Identity + current state of a REPEATED condition, e.g.
   * `{ id: "server:srv_1", state: "offline" }`. Omit for one-shot events.
   */
  dedupe?: { id: string; state: string };
}

/** How long one channel gets before the others stop waiting for it. */
export { CHANNEL_TIMEOUT_MS };

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
    if (
      alert.dedupe &&
      !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state)
    )
      return;
    // Per channel, not per team: each one carries its own selection, so a room
    // subscribed to this key hears about it while a phone that is not stays quiet.
    const channels = await channelsForAlert(alert.teamId, alert.key);
    if (channels.length === 0) return;

    const base = publicBaseUrl();
    // Nothing to look up unless there is a link to build; a team that has since
    // been deleted answers null, and the flat path still redirects on arrival.
    const slug = alert.path && base ? await teamSlugById(alert.teamId) : null;
    const msg = {
      key: alert.key,
      title: alert.title,
      body: alert.body,
      url: alert.path && base ? `${base}${withTeam(alert.path, slug)}` : null,
      ts: new Date().toISOString(),
    };
    // allSettled: a dead Discord webhook must not cost the email.
    const results = await Promise.allSettled(
      channels.map((c) =>
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
 * Raise a SERVER-level alert. Servers are the one cross-team resource, so the same
 * event reaches every team that has something running on the host.
 */
export function dispatchServerAlert(
  serverId: string,
  alert: Omit<Alert, "teamId">,
): void {
  if (
    alert.dedupe &&
    !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state)
  )
    return;
  void (async () => {
    for (const teamId of await teamsForServerAlerts(serverId))
      await dispatchAlertNow({ ...alert, teamId, dedupe: undefined });
  })().catch((e) => console.error("[deplo] server alert fan-out failed:", e));
}

/** Raise the same alert for several teams at once (a fleet-wide condition). */
export async function dispatchToTeams(
  teamIds: string[],
  alert: Omit<Alert, "teamId">,
): Promise<void> {
  if (
    alert.dedupe &&
    !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state)
  )
    return;
  // Awaitable, and detached by the CALLER: a fan-out that ends inside its own
  // `void` is one no test can wait for, only sleep at. It still never rejects,
  // so `void dispatchToTeams(...)` stays safe.
  try {
    for (const teamId of teamIds)
      await dispatchAlertNow({ ...alert, teamId, dedupe: undefined });
  } catch (e) {
    console.error("[deplo] alert fan-out failed:", e);
  }
}
