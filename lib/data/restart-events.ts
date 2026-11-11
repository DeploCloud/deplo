import "server-only";

import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { nowIso } from "../ids";
import { publishAppChanged } from "../graphql/pubsub";
import { dispatchAlert } from "../notify/dispatch";
import { recordActivity } from "./activity";
import { RestartEvent_Kind, type RestartEvent } from "../agent/gen/agent";

// One "stopped answering" alert per window, however many restarts land in it.
const WINDOW_MS = 30 * 60_000;

const RESUME_WHY: Record<string, string> = {
  deploy: "after a deploy",
  restart: "after a restart",
  quiet: "after 30 quiet minutes",
};

/** What the server agent's restart rule did, as Activity, App state and alerts. */
export async function applyRestartEvents(
  serverId: string,
  events: readonly RestartEvent[] | undefined,
): Promise<void> {
  for (const e of events ?? []) {
    try {
      await applyOne(serverId, e);
    } catch (err) {
      console.error("[deplo] restart event failed:", err);
    }
  }
}

async function applyOne(serverId: string, e: RestartEvent): Promise<void> {
  const [app] = await getDb()
    .select({
      id: appsTable.id,
      teamId: appsTable.teamId,
      name: appsTable.name,
      slug: appsTable.slug,
    })
    .from(appsTable)
    .where(
      and(
        eq(appsTable.slug, e.slug),
        eq(appsTable.serverId, serverId),
        isNull(appsTable.deletingAt),
      ),
    );
  if (!app) return;
  const path = `/apps/${app.slug}`;

  switch (e.kind) {
    case RestartEvent_Kind.KIND_RESTARTED: {
      await recordActivity(
        "app",
        `Restarted ${app.name}: it stopped answering for ${e.unansweredS} s`,
        "Deplo",
        app.id,
      );
      const now = Date.now();
      const first = await getDb()
        .update(appsTable)
        .set({
          unresponsiveAlertedAt: new Date(now).toISOString(),
          recoveryAlertOwed: true,
        })
        .where(
          and(
            eq(appsTable.id, app.id),
            or(
              isNull(appsTable.unresponsiveAlertedAt),
              lt(
                appsTable.unresponsiveAlertedAt,
                new Date(now - WINDOW_MS).toISOString(),
              ),
            ),
          ),
        )
        .returning({ id: appsTable.id });
      if (first.length === 0) return;
      dispatchAlert({
        teamId: app.teamId,
        key: "app_unresponsive",
        title: `${app.name} stopped answering`,
        body: `It was up but did not answer for ${e.unansweredS} s, so Deplo restarted it.`,
        path,
        appId: app.id,
      });
      return;
    }
    case RestartEvent_Kind.KIND_PAUSED: {
      const newly = await getDb()
        .update(appsTable)
        .set({ restartsPausedAt: nowIso(), recoveryAlertOwed: true })
        .where(
          and(eq(appsTable.id, app.id), isNull(appsTable.restartsPausedAt)),
        )
        .returning({ id: appsTable.id });
      if (newly.length > 0) publishAppChanged(app.id);
      await recordActivity(
        "app",
        `Paused restarts for ${app.name}: it restarted ${e.restarts} times in 30 minutes and still does not answer`,
        "Deplo",
        app.id,
      );
      if (newly.length === 0) return;
      dispatchAlert({
        teamId: app.teamId,
        key: "app_restarts_paused",
        title: `${app.name} is still not answering`,
        body: "Deplo restarted it several times and it did not help, so it stopped restarting it. The app is still running. The logs have why.",
        path,
        appId: app.id,
      });
      return;
    }
    case RestartEvent_Kind.KIND_RESUMED: {
      if (!(await clearRestartsPaused(app.id))) return;
      await recordActivity(
        "app",
        `Resumed restarts for ${app.name} ${RESUME_WHY[e.reason] ?? ""}`.trim(),
        "Deplo",
        app.id,
      );
      return;
    }
    case RestartEvent_Kind.KIND_RECOVERED: {
      const owed = await getDb()
        .update(appsTable)
        .set({ recoveryAlertOwed: false })
        .where(and(eq(appsTable.id, app.id), appsTable.recoveryAlertOwed))
        .returning({ id: appsTable.id });
      if (owed.length === 0) return;
      dispatchAlert({
        teamId: app.teamId,
        key: "app_unresponsive",
        title: `${app.name} is running again`,
        body: "It answers again.",
        path,
        appId: app.id,
      });
      return;
    }
  }
}

/** True when a pause was set and is now cleared. */
export async function clearRestartsPaused(appId: string): Promise<boolean> {
  const rows = await getDb()
    .update(appsTable)
    .set({ restartsPausedAt: null })
    .where(and(eq(appsTable.id, appId), isNotNull(appsTable.restartsPausedAt)))
    .returning({ id: appsTable.id });
  if (rows.length > 0) publishAppChanged(appId);
  return rows.length > 0;
}
