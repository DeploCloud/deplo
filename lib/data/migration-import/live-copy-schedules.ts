import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { requireActiveTeamId } from "../../membership";
import { plural } from "../../utils";

// A copy that keeps the source running lands every job paused, or both copies would run it.
export async function isLiveCopy(runId: string | null): Promise<boolean> {
  if (!runId) return false;
  const teamId = await requireActiveTeamId();
  const [run] = await getDb()
    .select({ liveCopy: runsTable.liveCopy })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  return run?.liveCopy ?? false;
}

export function pausedNote(
  name: string,
  landed: { crons?: number; schedules?: number },
): string | null {
  const what = [
    landed.crons ? plural(landed.crons, "cron", "crons") : "",
    landed.schedules
      ? plural(landed.schedules, "backup schedule", "backup schedules")
      : "",
  ]
    .filter(Boolean)
    .join(" and ");
  if (!what) return null;
  return `${what} came across paused: ${name} keeps running on {panel}, and both copies would otherwise run them. Turn them on here when you switch over.`;
}
