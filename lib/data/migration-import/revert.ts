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

// The message off whatever a delete threw, without leaking a stack.
function revertError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// stopMigration - stopping means UNDOING it, the whole thing, every time. The panel is
// left as the migration left it: services it stopped over there stay stopped, which the
// wizard says before it asks.
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

// undoMigration - take a run back out whole: what it created HERE, and the agent Deplo
// put over THERE to read it. The uninstall is FORCED past its usual guard.
export async function undoMigration(
  runId: string,
  // A person taking everything back out has no further use for the source; the AUTOMATIC
  // revert after a failure does - it took the agent off a machine the next attempt then
  // could not read.
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

// RevertResultDTO - what a revert managed to take back out, and what it could not.
export interface RevertResultDTO {
  apps: number;
  databases: number;
  environments: number;
  projects: number;
  sharedVars: number;
  // One line per thing that is still here, and why.
  failed: string[];
}

// revertMigration - take a migration back out of Deplo. A refusal arrives as a `failed`
// line rather than an exception, because one unreachable host must not strand the other
// ten objects. Undoing deletes the very rows it marked, so it is exempt from them too.
export async function revertMigration(
  runId: string,
  // `undo: true` is the automatic path (a Stop, a failed run). There, a run that is
  // already out is nothing left to do; asked for by hand, it is worth saying.
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
  // Everything is already gone, so a second pass would report every one of them
  // as a thing it could not remove.
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

  // One bulk call rather than N: it tears the stacks down with bounded concurrency, so
  // reverting twenty apps cannot flood one host's agent.
  const appIds = idsOf("app");
  if (appIds.length > 0) {
    const { deleteApps } = await import("../apps/delete");
    try {
      result.apps = await deleteApps(appIds);
    } catch (e) {
      failed.push(`Apps: ${revertError(e)}`);
    }
  }

  // One at a time, because each database holds its own lifecycle lock and its own proof
  // that the volume is gone.
  const { deleteDatabase } = await import("../databases/lifecycle");
  for (const id of idsOf("database")) {
    try {
      await deleteDatabase(id);
      result.databases += 1;
    } catch (e) {
      failed.push(`${nameOf(id)}: ${revertError(e)}`);
    }
  }

  // A project's environments go with it (the FK cascades), which is why the environment
  // pass below only has to look at the others.
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

  // Shared variables are matched by KEY, not by id: a report line for one carries no
  // target id and needs none, since a key that already existed is recorded `skipped` and
  // a `created` line can only be this run's own.
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

  // The environments added to a project that was already here.
  const { deleteEnvironment } = await import("../environments");
  for (const id of idsOf("environment")) {
    // One under a project this revert just removed went with it.
    if (await environmentIsGone(id)) continue;
    try {
      await deleteEnvironment(id);
      result.environments += 1;
    } catch (e) {
      failed.push(`${nameOf(id)}: ${revertError(e)}`);
    }
  }

  // What could NOT be taken back out goes into the run's own log, which is the only
  // place anybody looks afterwards.
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

  // The run stays in History - what happened is still what happened - but it says out
  // loud that it was taken back out, so nobody reads "12 created" as twelve apps that
  // exist.
  await getDb()
    .update(runsTable)
    .set({ status: "reverted", finishedAt: nowIso(), reportSeenAt: nowIso() })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  publishMigrationChanged();

  // Same `project` type the import itself writes under, so the two halves of
  // one migration sit together in the trail.
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

// Has this environment already gone with its project?
async function environmentIsGone(id: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: environmentsTable.id })
    .from(environmentsTable)
    .where(eq(environmentsTable.id, id));
  return rows.length === 0;
}
