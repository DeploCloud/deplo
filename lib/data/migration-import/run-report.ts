import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  migrationRunItems as itemsTable,
  migrationRuns as runsTable,
} from "../../db/schema/control-plane/migration";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { newId, nowIso } from "../../ids";
import { withPanel } from "../../migration/map/source-platform";
import { publishMigrationChanged } from "../../graphql/pubsub";

export interface ImportItemDTO {
  path: string;
  sourceKind: string;
  sourceName: string;
  // The source service id, on the rows that are a service. Null everywhere else.
  sourceId: string | null;
  outcome: string;
  targetKind: string | null;
  targetId: string | null;
  message: string | null;
  // When it happened. Null on rows written before the report became a log.
  at: string | null;
}

// ownRun - the writer's cheap ownership check, as ids only.
export async function ownRun(runId: string, teamId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  return rows.length > 0;
}

// refreshCounts - recount a run's totals from its items, so the history is right
// even if the tab that started the import never came back.
export async function refreshCounts(
  runId: string,
  teamId: string,
): Promise<void> {
  const rows = await getDb()
    .select({ outcome: itemsTable.outcome })
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));
  const count = (o: string) => rows.filter((r) => r.outcome === o).length;
  await getDb()
    .update(runsTable)
    .set({
      created: count("created"),
      skipped: count("skipped"),
      failed: count("failed"),
      // `unsupported` counts as "needs a look": it is a decision left to a person,
      // exactly like `manual`, and its own column would be a fifth number nobody asked
      // for.
      manual: count("manual") + count("unsupported"),
    })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  // Every writer of a run's state goes through here - a project landing, a
  // volume copied, Finish, Stop - so this is the one place the live "a
  // migration is running" chip has to be told about.
  publishMigrationChanged();
}

// Report - a report collector: rows go to the run AND come back to the caller.
// `at()` deepens the breadcrumb but SHARES the items array, so the caller gets one
// flat report for the whole project, in the order things happened.
export class Report {
  // The run these lines belong to, for the tables that hang off it.
  get id(): string | null {
    return this.runId;
  }
  constructor(
    private readonly runId: string | null,
    // The source product's name: a mapper writes `{panel}` and this is what it becomes.
    private readonly panel: string,
    private readonly path: string[] = [],
    readonly items: ImportItemDTO[] = [],
  ) {}

  // A child collector one level deeper in the breadcrumb, same run, same list.
  at(segment: string): Report {
    return new Report(
      this.runId,
      this.panel,
      [...this.path, segment],
      this.items,
    );
  }

  async add(entry: {
    path?: string;
    sourceKind: string;
    sourceName: string;
    // The source service id, when this row IS a service. What the data cutover pairs on.
    sourceId?: string | null;
    outcome: "created" | "skipped" | "failed" | "manual" | "unsupported";
    targetKind?: string | null;
    targetId?: string | null;
    message?: string | null;
  }): Promise<void> {
    const row: ImportItemDTO = {
      path: withPanel(entry.path ?? this.path.join(" / "), this.panel),
      sourceKind: entry.sourceKind,
      // Every COLUMN a person reads, not only the message: a row whose subject is
      // the panel itself has the placeholder in its name.
      sourceName: withPanel(entry.sourceName, this.panel),
      sourceId: entry.sourceId ?? null,
      outcome: entry.outcome,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      message: entry.message ? withPanel(entry.message, this.panel) : null,
      // Stamped here, once, so the in-memory copy the caller reads and the row
      // the log reads agree on when it happened.
      at: nowIso(),
    };
    this.items.push(row);
    if (!this.runId) return;
    // The data phase writes every plan note, then the copy writes the same notes
    // again from its own read of the panel - so one advisory reached the report
    // twice, word for word. An outcome line is never dropped; advice is.
    if (row.outcome === "manual" && (await this.alreadySaid(row))) return;
    await getDb()
      .insert(itemsTable)
      .values({ id: newId("dimi"), runId: this.runId, ...row });
    // Everything this run CREATES is the run's to write until it ends.
    if (row.outcome === "created") await markMigrating(this.runId, row);
  }

  /** Has this run already recorded this exact advisory, on this exact subject? */
  private async alreadySaid(row: ImportItemDTO): Promise<boolean> {
    if (!row.message) return false;
    const hit = await getDb()
      .select({ id: itemsTable.id })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.runId, this.runId!),
          eq(itemsTable.outcome, "manual"),
          eq(itemsTable.path, row.path),
          eq(itemsTable.message, row.message),
        ),
      )
      .limit(1);
    return hit.length > 0;
  }

  /** Every note from a mapper, as its own `manual` line. */
  async notes(
    kind: string,
    name: string,
    notes: string[],
    target?: { kind: string; id: string },
    sourceId?: string | null,
  ): Promise<void> {
    for (const message of notes)
      await this.add({
        sourceKind: kind,
        sourceName: name,
        sourceId: sourceId ?? null,
        outcome: "manual",
        targetKind: target?.kind ?? null,
        targetId: target?.id ?? null,
        message,
      });
  }
}

// appendRunItem - one line into a run's report, for a caller with no `Report` tree
// of its own (the data cutover writes a handful of rows across separate requests).
export async function appendRunItem(
  runId: string,
  panel: string,
  entry: {
    path: string;
    sourceKind: string;
    sourceName: string;
    sourceId?: string | null;
    outcome: "created" | "skipped" | "failed" | "manual" | "unsupported";
    targetKind?: string | null;
    targetId?: string | null;
    message?: string | null;
  },
): Promise<void> {
  await new Report(runId, panel).add(entry);
}

// Which table holds a target of each kind. Unknown kinds are simply not marked.
const MIGRATING_TABLES = {
  app: appsTable,
  database: databasesTable,
  project: projectsTable,
  environment: environmentsTable,
} as const;

// Stamp a freshly created row with the run that is still writing to it.
async function markMigrating(
  runId: string,
  row: { targetKind: string | null; targetId: string | null },
): Promise<void> {
  const table =
    MIGRATING_TABLES[row.targetKind as keyof typeof MIGRATING_TABLES];
  if (!table || !row.targetId) return;
  await getDb()
    .update(table)
    .set({ migrationRunId: runId })
    .where(
      and(
        eq(table.id, row.targetId),
        // Only while the run is OPEN. A re-copy appends its `created` lines to a
        // run that finished long ago, and marking there froze the app for good.
        sql`exists (select 1 from ${runsTable} where ${runsTable.id} = ${runId} and ${runsTable.status} = 'running')`,
      ),
    );
}

// sweepFinishedMigrationMarks - the marker outlives its run, and a row still
// carrying one refuses every deploy behind a migration there is nothing left to finish.
export async function sweepFinishedMigrationMarks(): Promise<void> {
  for (const table of Object.values(MIGRATING_TABLES))
    await getDb()
      .update(table)
      .set({ migrationRunId: null })
      .where(
        sql`${table.migrationRunId} is not null and not exists (
          select 1 from ${runsTable}
          where ${runsTable.id} = ${table.migrationRunId}
            and ${runsTable.status} = 'running'
        )`,
      );
}

// releaseMigrating - hand everything this run created back to the people who own it.
// A run that FAILS has to let go too, or its apps are frozen for good.
export async function releaseMigrating(runId: string): Promise<void> {
  for (const table of Object.values(MIGRATING_TABLES))
    await getDb()
      .update(table)
      .set({ migrationRunId: null })
      .where(eq(table.migrationRunId, runId));
}
