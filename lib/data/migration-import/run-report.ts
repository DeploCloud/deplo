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
  sourceId: string | null;
  outcome: string;
  targetKind: string | null;
  targetId: string | null;
  message: string | null;
  at: string | null;
}

export async function ownRun(runId: string, teamId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  return rows.length > 0;
}

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
      manual: count("manual") + count("unsupported"),
    })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  publishMigrationChanged();
}

export class Report {
  get id(): string | null {
    return this.runId;
  }
  constructor(
    private readonly runId: string | null,
    private readonly panel: string,
    private readonly path: string[] = [],
    readonly items: ImportItemDTO[] = [],
  ) {}

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
    sourceId?: string | null;
    outcome: "created" | "skipped" | "failed" | "manual" | "unsupported";
    targetKind?: string | null;
    targetId?: string | null;
    message?: string | null;
  }): Promise<void> {
    const row: ImportItemDTO = {
      path: withPanel(entry.path ?? this.path.join(" / "), this.panel),
      sourceKind: entry.sourceKind,
      sourceName: withPanel(entry.sourceName, this.panel),
      sourceId: entry.sourceId ?? null,
      outcome: entry.outcome,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      message: entry.message ? withPanel(entry.message, this.panel) : null,
      at: nowIso(),
    };
    this.items.push(row);
    if (!this.runId) return;
    if (row.outcome === "manual" && (await this.alreadySaid(row))) return;
    await getDb()
      .insert(itemsTable)
      .values({ id: newId("dimi"), runId: this.runId, ...row });
    if (row.outcome === "created") await markMigrating(this.runId, row);
  }

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

const MIGRATING_TABLES = {
  app: appsTable,
  database: databasesTable,
  project: projectsTable,
  environment: environmentsTable,
} as const;

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
        sql`exists (select 1 from ${runsTable} where ${runsTable.id} = ${runId} and ${runsTable.status} = 'running')`,
      ),
    );
}

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

export async function releaseMigrating(runId: string): Promise<void> {
  for (const table of Object.values(MIGRATING_TABLES))
    await getDb()
      .update(table)
      .set({ migrationRunId: null })
      .where(eq(table.migrationRunId, runId));
}
