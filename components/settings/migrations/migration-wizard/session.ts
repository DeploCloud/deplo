import type { ActiveMigration } from "@/components/layout/migration-activity";
import type { ImportRun, MigrationProgress, SessionRun } from "../types";

export interface RunReport {
  created: number;
  skipped: number;
  failed: number;
  manual: number;
}

export const NO_PROGRESS: MigrationProgress = {
  done: 0,
  total: 0,
  current: "",
};

export function sum(
  runs: SessionRun[],
  key: "created" | "skipped" | "failed" | "manual",
): number {
  return runs.reduce((n, r) => n + r[key], 0);
}

export function lastStep(path: string | null | undefined): string {
  if (!path) return "";
  const tail = path.split(" / ").pop()?.trim();
  return tail ?? "";
}

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
