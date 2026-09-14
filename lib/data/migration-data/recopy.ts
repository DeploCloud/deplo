import "server-only";

import { and, desc, eq, isNotNull, ne } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  migrationRunItems as itemsTable,
  migrationRuns as runsTable,
} from "../../db/schema/control-plane/migration";
import {
  reachesWholeTeam,
  requireActiveTeamId,
  requireCapability,
} from "../../membership";

import { requireAppCapability } from "../node-access";
import { appendRunItem } from "../migration-import/run-report";

/** Where a blocked workload's data still is, so it can be fetched again. */
export interface RecopySource {
  runId: string;
  /** The panel's address, as the run recorded it. Its key is NOT kept. */
  sourceUrl: string;
  platform: string;
  sourceKind: string;
  sourceId: string;
  sourceName: string;
}

/**
 * The service this app or database was imported from. The report is the record:
 * the run's key is wiped the moment it ends, so copying the data again asks for it
 * once more and everything else it needs is here rather than typed by hand.
 */
export async function recopySourceFor(
  kind: "app" | "database",
  id: string,
): Promise<RecopySource | null> {
  if (kind === "app") await requireAppCapability(id, "restore_backups");
  else {
    if (!(await reachesWholeTeam())) throw new Error("Not found");
    await requireCapability("restore_backups");
  }
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({
      runId: itemsTable.runId,
      sourceKind: itemsTable.sourceKind,
      sourceId: itemsTable.sourceId,
      sourceName: itemsTable.sourceName,
      sourceUrl: runsTable.sourceUrl,
      platform: runsTable.platform,
    })
    .from(itemsTable)
    .innerJoin(runsTable, eq(runsTable.id, itemsTable.runId))
    .where(
      and(
        eq(runsTable.teamId, teamId),
        eq(itemsTable.targetKind, kind),
        eq(itemsTable.targetId, id),
        isNotNull(itemsTable.sourceId),
        ne(itemsTable.sourceKind, "volume"),
      ),
    )
    .orderBy(desc(itemsTable.seq))
    .limit(1);
  const hit = rows[0];
  if (!hit?.sourceId) return null;
  return {
    runId: hit.runId,
    sourceUrl: hit.sourceUrl,
    platform: hit.platform,
    sourceKind: hit.sourceKind,
    sourceId: hit.sourceId,
    sourceName: hit.sourceName,
  };
}

/**
 * Every service this run landed on whose data is NOT here yet, marked so: the
 * data phase ended before it reached them (a fault outside the per-service loop,
 * a Stop), and unmarked they came up on empty storage with nothing refusing.
 * Returns how many were marked now.
 */
export async function markRunTargetsUncopied(
  runId: string,
  why: string,
): Promise<number> {
  const rows = await getDb()
    .select({
      path: itemsTable.path,
      sourceKind: itemsTable.sourceKind,
      sourceId: itemsTable.sourceId,
      sourceName: itemsTable.sourceName,
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
      outcome: itemsTable.outcome,
    })
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));
  const seen = new Set<string>();
  let marked = 0;
  for (const r of rows) {
    if (r.outcome !== "created" && r.outcome !== "skipped") continue;
    if (r.targetKind !== "app" && r.targetKind !== "database") continue;
    if (!r.targetId || seen.has(r.targetId)) continue;
    seen.add(r.targetId);
    const { dataAlreadyCopiedInto, markDataCopyFailed } =
      await import("../data-copy");
    if (await dataAlreadyCopiedInto(runId, r.targetId)) continue;
    const table = r.targetKind === "app" ? appsTable : databasesTable;
    const [cur] = await getDb()
      .select({ err: table.dataCopyError })
      .from(table)
      .where(eq(table.id, r.targetId))
      .limit(1);
    if (!cur || cur.err) continue;
    const reason = `${r.sourceName}'s data was not copied: ${why}`;
    await markDataCopyFailed({ kind: r.targetKind, id: r.targetId }, reason);
    await appendRunItem(runId, "the panel", {
      path: r.path,
      sourceKind: r.sourceKind,
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      outcome: "failed",
      targetKind: r.targetKind,
      targetId: r.targetId,
      message: `${reason}. It refuses to deploy until the data is brought over, or "Deploy anyway" accepts starting without it.`,
    });
    marked++;
  }
  return marked;
}
