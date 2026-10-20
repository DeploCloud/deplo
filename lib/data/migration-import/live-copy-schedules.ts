import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backups as backupsTable } from "../../db/schema/control-plane/backups";
import { cronJobs as cronsTable } from "../../db/schema/control-plane/crons";
import {
  migrationRunItems as itemsTable,
  migrationRuns as runsTable,
} from "../../db/schema/control-plane/migration";
import { requireActiveTeamId } from "../../membership";
import { panelNameFor } from "../migration-runner/runner-state";
import { appendRunItem } from "./run-report";

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// The source keeps running its own jobs, so the copy's would run them twice (ADR-0035 pauses them for the same reason).
export async function pauseCopiedSchedules(runId: string): Promise<void> {
  const teamId = await requireActiveTeamId();
  const [run] = await getDb()
    .select({ platform: runsTable.platform, sourceUrl: runsTable.sourceUrl })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  if (!run) return;
  const landed = await getDb()
    .selectDistinct({
      path: itemsTable.path,
      sourceKind: itemsTable.sourceKind,
      sourceName: itemsTable.sourceName,
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.runId, runId),
        eq(itemsTable.outcome, "created"),
        inArray(itemsTable.targetKind, ["app", "database"]),
        isNotNull(itemsTable.targetId),
      ),
    );
  const seen = new Set<string>();
  for (const t of landed) {
    const key = `${t.targetKind}:${t.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isApp = t.targetKind === "app";
    const crons = await getDb()
      .update(cronsTable)
      .set({ enabled: false })
      .where(
        and(
          eq(cronsTable.teamId, teamId),
          eq(cronsTable.enabled, true),
          isApp
            ? eq(cronsTable.appId, t.targetId!)
            : eq(cronsTable.databaseId, t.targetId!),
        ),
      )
      .returning({ id: cronsTable.id });
    const schedules = await getDb()
      .update(backupsTable)
      .set({ enabled: false })
      .where(
        and(
          eq(backupsTable.teamId, teamId),
          eq(backupsTable.enabled, true),
          isApp
            ? eq(backupsTable.appId, t.targetId!)
            : eq(backupsTable.databaseId, t.targetId!),
        ),
      )
      .returning({ id: backupsTable.id });
    if (crons.length === 0 && schedules.length === 0) continue;
    const what = [
      crons.length ? plural(crons.length, "cron") : "",
      schedules.length ? plural(schedules.length, "backup schedule") : "",
    ]
      .filter(Boolean)
      .join(" and ");
    await appendRunItem(runId, panelNameFor(run), {
      path: t.path,
      sourceKind: t.sourceKind,
      sourceName: t.sourceName,
      outcome: "manual",
      targetKind: t.targetKind,
      targetId: t.targetId,
      message: `${what} came across paused: ${t.sourceName} keeps running on {panel}, and both copies would otherwise run them. Turn them on here when you switch over.`,
    });
  }
}
