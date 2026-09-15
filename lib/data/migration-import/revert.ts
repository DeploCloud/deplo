import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  migrationRunItems as itemsTable,
  migrationRuns as runsTable,
} from "../../db/schema/control-plane/migration";
import { environments as environmentsTable } from "../../db/schema/control-plane/projects";
import { nowIso } from "../../ids";
import { getCurrentUser } from "../../auth/current-user";
import { recordActivity } from "../activity";
import { runAsMigration } from "../migration-guard";
import { publishMigrationChanged } from "../../graphql/pubsub";
import { assertImportGate } from "./gates";
import { appendRunItem, refreshCounts, releaseMigrating } from "./run-report";
import { removeMigrationSources } from "./source-agents";

function revertError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function stopMigration(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  await getDb()
    .update(runsTable)
    .set({ status: "stopped", finishedAt: nowIso() })
    .where(
      and(
        eq(runsTable.id, runId),
        eq(runsTable.teamId, teamId),
        eq(runsTable.status, "running"),
      ),
    );
  await undoMigration(runId);
}

export async function undoMigration(
  runId: string,
  opts: { forceSourceRemoval?: boolean } = {},
): Promise<void> {
  const { teamId } = await assertImportGate();
  await releaseMigrating(runId);
  await revertMigration(runId, { undo: true });
  await removeMigrationSources(runId, teamId, {
    force: opts.forceSourceRemoval !== false,
  });
  await refreshCounts(runId, teamId);
}

export interface RevertResultDTO {
  apps: number;
  databases: number;
  environments: number;
  projects: number;
  sharedVars: number;
  failed: string[];
}

export async function revertMigration(
  runId: string,
  opts: { undo?: boolean } = {},
): Promise<RevertResultDTO> {
  return runAsMigration(() => runRevertMigration(runId, opts));
}

async function runRevertMigration(
  runId: string,
  opts: { undo?: boolean },
): Promise<RevertResultDTO> {
  const { teamId } = await assertImportGate();
  const [run] = await getDb()
    .select({ status: runsTable.status })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)))
    .limit(1);
  if (!run) throw new Error("Migration not found");
  if (run.status === "reverted") {
    if (!opts.undo) throw new Error("This import was already taken back out.");
    return {
      apps: 0,
      databases: 0,
      environments: 0,
      projects: 0,
      sharedVars: 0,
      failed: [],
    };
  }

  const rows = await getDb()
    .select({
      path: itemsTable.path,
      sourceName: itemsTable.sourceName,
      targetKind: itemsTable.targetKind,
      targetId: itemsTable.targetId,
    })
    .from(itemsTable)
    .where(and(eq(itemsTable.runId, runId), eq(itemsTable.outcome, "created")));

  const idsOf = (kind: string) => [
    ...new Set(
      rows
        .filter((r) => r.targetKind === kind && r.targetId)
        .map((r) => r.targetId!),
    ),
  ];
  const nameOf = (id: string) =>
    rows.find((r) => r.targetId === id)?.sourceName ?? id;

  const failed: string[] = [];
  const result: RevertResultDTO = {
    apps: 0,
    databases: 0,
    environments: 0,
    projects: 0,
    sharedVars: 0,
    failed,
  };

  const appIds = idsOf("app");
  if (appIds.length > 0) {
    const { deleteApps } = await import("../apps/delete");
    try {
      result.apps = await deleteApps(appIds);
    } catch (e) {
      failed.push(`Apps: ${revertError(e)}`);
    }
  }

  const { deleteDatabase } = await import("../databases/lifecycle");
  for (const id of idsOf("database")) {
    try {
      await deleteDatabase(id);
      result.databases += 1;
    } catch (e) {
      failed.push(`${nameOf(id)}: ${revertError(e)}`);
    }
  }

  const projectIds = idsOf("project");
  const { deleteProject } = await import("../projects/lifecycle");
  for (const id of projectIds) {
    try {
      await deleteProject(id);
      result.projects += 1;
    } catch (e) {
      failed.push(`${nameOf(id)}: ${revertError(e)}`);
    }
  }

  const varKeys = new Set(
    rows.filter((r) => r.targetKind === "shared-var").map((r) => r.sourceName),
  );
  if (varKeys.size > 0) {
    const { deleteSharedVar } = await import("../shared-vars/authoring");
    const { listSharedVars } = await import("../shared-vars/team-view");
    try {
      for (const v of await listSharedVars()) {
        if (!varKeys.has(v.key)) continue;
        try {
          await deleteSharedVar(v.id);
          result.sharedVars += 1;
        } catch (e) {
          failed.push(`${v.key}: ${revertError(e)}`);
        }
      }
    } catch (e) {
      failed.push(`Shared variables: ${revertError(e)}`);
    }
  }

  const { deleteEnvironment } = await import("../environments");
  for (const id of idsOf("environment")) {
    if (await environmentIsGone(id)) continue;
    try {
      await deleteEnvironment(id);
      result.environments += 1;
    } catch (e) {
      failed.push(`${nameOf(id)}: ${revertError(e)}`);
    }
  }

  for (const line of failed) {
    const [head, ...rest] = line.split(": ");
    await appendRunItem(runId, "the panel", {
      path: `Undo / ${head}`,
      sourceKind: "undo",
      sourceName: head,
      outcome: "failed",
      message: rest.join(": ") || "could not be removed",
    });
  }

  await getDb()
    .update(runsTable)
    .set({ status: "reverted", finishedAt: nowIso(), reportSeenAt: nowIso() })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  publishMigrationChanged();

  await recordActivity(
    "project",
    `Reverted a migration: removed ${result.apps} app(s), ` +
      `${result.databases} database(s) and ${result.projects} project(s)`,
    (await getCurrentUser())?.name ?? "Someone",
    null,
    teamId,
  );

  return result;
}

async function environmentIsGone(id: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: environmentsTable.id })
    .from(environmentsTable)
    .where(eq(environmentsTable.id, id));
  return rows.length === 0;
}
