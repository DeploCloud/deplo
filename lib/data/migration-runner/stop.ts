import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { publishMigrationChanged } from "../../graphql/pubsub";
import { restartSourcesStoppedByRun } from "../migration-data/source-cutover";
import { assertImportGate } from "../migration-import/gates";
import { stopMigration } from "../migration-import/revert";
import { appendRunItem } from "../migration-import/run-report";
import { STALE_MS, credentialFor, panelNameFor } from "./runner-state";

export async function requestStopMigrationRun(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  const [row] = await getDb()
    .update(runsTable)
    .set({ stopRequested: true })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)))
    .returning({
      heartbeatAt: runsTable.heartbeatAt,
      status: runsTable.status,
    });
  publishMigrationChanged();
  if (!row || row.status !== "running") return;

  const beatAt = row.heartbeatAt ? Date.parse(row.heartbeatAt) : 0;
  if (Date.now() - beatAt < STALE_MS) return;
  await stopRun(runId);
}

export async function stopWanted(runId: string): Promise<boolean> {
  const [r] = await getDb()
    .select({ stop: runsTable.stopRequested, status: runsTable.status })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  return !r || r.status !== "running" || r.stop;
}

export async function stopped(runId: string): Promise<boolean> {
  const [r] = await getDb()
    .select({ stop: runsTable.stopRequested, status: runsTable.status })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  if (!r) return true;
  if (r.status !== "running") return true;
  if (!r.stop) return false;
  await stopRun(runId);
  return true;
}

async function stopRun(runId: string): Promise<void> {
  const [row] = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  if (row && row.phase === "data") {
    let restarted = { restarted: 0, left: [] as string[] };
    try {
      const c = await credentialFor(row);
      restarted = await restartSourcesStoppedByRun(runId, {
        kind: c.kind,
        baseUrl: c.url,
        apiKey: c.apiKey,
      });
    } catch (e) {
      restarted.left.push(e instanceof Error ? e.message : String(e));
    }
    await appendRunItem(runId, panelNameFor(row), {
      path: "Migration",
      sourceKind: "run",
      sourceName: "Migration",
      outcome: "manual",
      message: `Stopped during the data step, so everything it created here is removed. The copy reads {panel}, it never empties it, so your data is still there. ${restarted.restarted > 0 ? `${restarted.restarted} service(s) were started again on {panel}.` : ""}${restarted.left.length > 0 ? ` Still stopped on {panel}: ${restarted.left.join("; ")}.` : ""}`,
    });
  }
  await stopMigration(runId);
  await getDb()
    .update(runsTable)
    .set({ apiKeyEnc: null, runnerOwner: null, phase: "done" })
    .where(eq(runsTable.id, runId));
  publishMigrationChanged();
}
