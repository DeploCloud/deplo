import type { ActiveMigration } from "@/components/layout/migration-activity";
import type { ImportRun, MigrationProgress, SessionRun } from "../types";

// RunReport - what the finished run says about itself, kept for the report card.
export interface RunReport {
  created: number;
  skipped: number;
  failed: number;
  manual: number;
}

// NO_PROGRESS - nothing has moved yet, or this tab does not know what has.
export const NO_PROGRESS: MigrationProgress = {
  done: 0,
  total: 0,
  current: "",
};

// sum - one column of the walk's runs added up; the report is the whole list's.
export function sum(
  runs: SessionRun[],
  key: "created" | "skipped" | "failed" | "manual",
): number {
  return runs.reduce((n, r) => n + r[key], 0);
}

// lastStep - the tail of a run item's path: `Backups / production / jellyfin` becomes `jellyfin`.
export function lastStep(path: string | null | undefined): string {
  if (!path) return "";
  const tail = path.split(" / ").pop()?.trim();
  return tail ?? "";
}

// asActive - the page's snapshot of a run, in the shape the live feed uses.
export function asActive(run: ImportRun): ActiveMigration {
  return {
    id: run.id,
    status: run.status,
    sourceUrl: run.sourceUrl,
    orgName: run.orgName,
    actor: run.actor,
    startedAt: run.startedAt,
    created: run.created,
    skipped: run.skipped,
    failed: run.failed,
    manual: run.manual,
    lastPath: run.lastPath ?? null,
    phase: run.phase ?? "config",
    doneSteps: run.doneSteps ?? 0,
    totalSteps: run.totalSteps ?? 0,
    stepLabel: run.stepLabel ?? null,
    heartbeatAt: run.heartbeatAt ?? null,
  };
}
