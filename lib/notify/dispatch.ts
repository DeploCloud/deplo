import "server-only";

// https://deplo.build/docs/guides/observability/notifications-and-alerts

import { channelsForAlert } from "../data/notifications";
import { teamSlugById } from "../data/teams";
import { withTeam } from "../team-path";
import { publicBaseUrl } from "../public-url";
import { CHANNEL_TIMEOUT_MS, sendToChannel } from "./channels";
import { shouldFire } from "./cooldown";
import { teamsForServerAlerts } from "./server-teams";
import type { AlertKey } from "../types/notification";

// `teamId` is passed in: AsyncLocalStorage would answer null exactly when it matters.
export interface Alert {
  teamId: string;
  key: AlertKey;
  // One line: what happened, to what.
  title: string;
  // One or two lines: the actionable detail.
  body: string;
  // Dashboard path, written FLAT (`/apps/api`): the team and the panel address are put on it here.
  path?: string;
  // Identity + current state of a REPEATED condition; omit for one-shot events.
  dedupe?: { id: string; state: string };
}

// How long one channel gets before the others stop waiting for it.
export { CHANNEL_TIMEOUT_MS };

// Raise an alert. Never throws, never blocks the caller. THE default.
export function dispatchAlert(alert: Alert): void {
  void dispatchAlertNow(alert).catch((e) =>
    console.error("[deplo] alert dispatch failed:", e),
  );
}

// The awaited variant, for tests and for a caller that genuinely wants to wait.
export async function dispatchAlertNow(alert: Alert): Promise<void> {
  try {
    // Dedupe FIRST: a suppressed alert must cost zero queries.
    if (
      alert.dedupe &&
      !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state)
    )
      return;
    // Per channel, not per team: each one carries its own selection of keys.
    const channels = await channelsForAlert(alert.teamId, alert.key);
    if (channels.length === 0) return;

    const base = publicBaseUrl();
    // A team since deleted answers null, and the flat path still redirects on arrival.
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

// Servers are the one cross-team resource, so this reaches every team with something on the host.
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

// Raise the same alert for several teams at once (a fleet-wide condition).
export async function dispatchToTeams(
  teamIds: string[],
  alert: Omit<Alert, "teamId">,
): Promise<void> {
  if (
    alert.dedupe &&
    !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state)
  )
    return;
  // Detached by the CALLER so a test can await it; it never rejects, so `void` stays safe.
  try {
    for (const teamId of teamIds)
      await dispatchAlertNow({ ...alert, teamId, dedupe: undefined });
  } catch (e) {
    console.error("[deplo] alert fan-out failed:", e);
  }
}
