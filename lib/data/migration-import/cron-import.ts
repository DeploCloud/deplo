import "server-only";

import { errorMessage } from "../../utils";
import type { Note } from "../../migration/note";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import type { CronTargetKind } from "../../types/cron";
import { createCronJob } from "../crons/job-crud";

function renamedService(
  name: string | null | undefined,
  renames: Map<string, string>,
): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return renames.get(trimmed.toLowerCase()) ?? trimmed;
}

// `scheduleType` is the source's kind for the workload: application, compose, or a database engine.
export async function importCrons(
  c: SourceCredential,
  scheduleType: string,
  sourceId: string,
  target: { kind: CronTargetKind; id: string },
  notes: Note[],
  serviceRenames: Map<string, string> = new Map(),
): Promise<void> {
  for (const s of await sourceClient(c).listSchedules(scheduleType, sourceId)) {
    const command = (s.command ?? s.script ?? "").trim();
    if (!command) {
      notes.push(
        `Cron "${s.name}" has no command on {panel}, so it did not come across.`,
      );
      continue;
    }
    try {
      await createCronJob(target.kind, target.id, {
        name: s.name,
        schedule: s.cronExpression,
        command,
        service: renamedService(s.serviceName, serviceRenames),
        enabled: s.enabled !== false,
      });
    } catch (e) {
      notes.push(
        `Cron "${s.name}" did not come across: ${errorMessage(e, "refused")}.`,
      );
    }
  }
}
