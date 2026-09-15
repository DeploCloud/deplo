import "server-only";

import { channelsForAlert } from "../data/notifications";
import { teamSlugById } from "../data/teams";
import { withTeam } from "../team-path";
import { publicBaseUrl } from "../public-url";
import { CHANNEL_TIMEOUT_MS, sendToChannel } from "./channels";
import { shouldFire } from "./cooldown";
import { teamsForServerAlerts } from "./server-teams";
import type { AlertKey } from "../types/notification";

export interface Alert {
  // Passed in, never read from AsyncLocalStorage: the dispatcher runs detached, where it would answer null.
  teamId: string;
  key: AlertKey;
  title: string;
  body: string;
  path?: string;
  dedupe?: { id: string; state: string };
}

export { CHANNEL_TIMEOUT_MS };

export function dispatchAlert(alert: Alert): void {
  void dispatchAlertNow(alert).catch((e) =>
    console.error("[deplo] alert dispatch failed:", e),
  );
}

export async function dispatchAlertNow(alert: Alert): Promise<void> {
  try {
    if (
      alert.dedupe &&
      !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state)
    )
      return;
    const channels = await channelsForAlert(alert.teamId, alert.key);
    if (channels.length === 0) return;

    const base = publicBaseUrl();
    const slug = alert.path && base ? await teamSlugById(alert.teamId) : null;
    const msg = {
      key: alert.key,
      title: alert.title,
      body: alert.body,
      url: alert.path && base ? `${base}${withTeam(alert.path, slug)}` : null,
      ts: new Date().toISOString(),
    };
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

export async function dispatchToTeams(
  teamIds: string[],
  alert: Omit<Alert, "teamId">,
): Promise<void> {
  if (
    alert.dedupe &&
    !shouldFire(alert.key, alert.dedupe.id, alert.dedupe.state)
  )
    return;
  try {
    for (const teamId of teamIds)
      await dispatchAlertNow({ ...alert, teamId, dedupe: undefined });
  } catch (e) {
    console.error("[deplo] alert fan-out failed:", e);
  }
}
