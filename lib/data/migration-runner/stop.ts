import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { publishMigrationChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import { markRunTargetsUncopied } from "../migration-data/recopy";
import { restartSourcesStoppedByRun } from "../migration-data/source-cutover";
import { assertImportGate } from "../migration-import/gates";
import { stopMigration } from "../migration-import/revert";
import {
  appendRunItem,
  releaseMigrating,
} from "../migration-import/run-report";
import { STALE_MS, credentialFor, panelNameFor } from "./runner-state";

// requestStopMigrationRun - ask a run to stop. It notices between steps; nothing is abandoned mid-call.
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

  // Nobody is driving it. The flag alone would leave the row `running` forever -
  // which is what a run whose runner died without a successor looks like.
  const beatAt = row.heartbeatAt ? Date.parse(row.heartbeatAt) : 0;
  if (Date.now() - beatAt < STALE_MS) return;
  await stopRun(runId);
}

/** Is this run still wanted? A pure read - it is called from the heartbeat, which
 *  must never undo anything by itself. */
export async function stopWanted(runId: string): Promise<boolean> {
  const [r] = await getDb()
    .select({ stop: runsTable.stopRequested, status: runsTable.status })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  return !r || r.status !== "running" || r.stop;
}

/** Has somebody asked it to stop? Read fresh, between steps, every time - and if
 *  they have, this is where the migration is taken back out. */
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

// A Stop, honoured. In the config phase it is total; in the DATA phase what was
// created is kept, marked, and the source's services are started again.
async function stopRun(runId: string): Promise<void> {
  const [row] = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  if (row && row.phase === "data") {
    await getDb()
      .update(runsTable)
      // Seen: the person stopped it themselves, and an unseen stop reopened the
      // wizard on it - toast included - every time they came back.
      .set({ status: "stopped", finishedAt: nowIso(), reportSeenAt: nowIso() })
      .where(and(eq(runsTable.id, runId), eq(runsTable.status, "running")));
    await releaseMigrating(runId);
    await markRunTargetsUncopied(runId, "the migration was stopped").catch(
      () => 0,
    );
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
      message: `Stopped during the data step. Everything created here was kept; the lines above name every service whose data is not here yet. ${restarted.restarted > 0 ? `${restarted.restarted} service(s) were started again on {panel}.` : ""}${restarted.left.length > 0 ? ` Still stopped on {panel}: ${restarted.left.join("; ")}.` : ""} Deplo's agent stays on the source machines so the copy can run again.`,
    });
  } else {
    await stopMigration(runId);
  }
  await getDb()
    .update(runsTable)
    .set({ apiKeyEnc: null, runnerOwner: null, phase: "done" })
    .where(eq(runsTable.id, runId));
  publishMigrationChanged();
}
