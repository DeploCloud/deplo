import "server-only";

import type { Note } from "../../migration/note";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import type { CronTargetKind } from "../../types/cron";
import { createCronJob, setCronEnabled } from "../crons/job-crud";

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
  opts: {
    serviceRenames?: Map<string, string>;
    cronEnabled?: boolean | null;
    paused?: boolean;
  } = {},
): Promise<number> {
  const renames = opts.serviceRenames ?? new Map<string, string>();
  let landed = 0;
  for (const s of await sourceClient(c).listSchedules(scheduleType, sourceId)) {
    const command = (s.command ?? s.script ?? "").trim();
    if (!command) {
      notes.push(`Cron "${s.name}" has no command on {panel} - not imported.`);
      continue;
    }
    try {
      await createCronJob(target.kind, target.id, {
        ...s.native,
        name: s.name,
        schedule: s.cronExpression,
        command,
        service: renamedService(s.serviceName, renames),
        enabled: !opts.paused && s.enabled !== false,
        env: s.env ?? undefined,
      });
      landed++;
    } catch (e) {
      notes.push(
        `Cron "${s.name}" was not imported: ${e instanceof Error ? e.message : "refused"}.`,
      );
    }
  }
  if (opts.cronEnabled !== true) return landed;
  try {
    await setCronEnabled(target.kind, target.id, true);
  } catch (e) {
    notes.push(
      `Cron jobs ran on {panel} but are switched off here: ${e instanceof Error ? e.message : "refused"}. Switch them on under Crons.`,
    );
  }
  return landed;
}
