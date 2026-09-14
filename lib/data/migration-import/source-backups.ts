import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backups as backupsTable } from "../../db/schema/control-plane/backups";
import { sourceClient } from "../../migration/source";
import type {
  MigrationSourceClient,
  SourceCredential,
} from "../../migration/source";
import type { SourceBackupSchedule } from "../../migration/model";
import type { Report } from "./run-report";

// The source's backup schedules as backups on `target`, one per schedule and
// destination, skipping any the target already holds - so a second pass adds what the
// first could not (a destination that was not here yet) and no more.
export async function landSourceBackups(
  backups: SourceBackupSchedule[] | null | undefined,
  destinations: Map<string, string> | undefined,
  target: { kind: "app" | "database"; id: string; name: string },
  notes: string[],
): Promise<void> {
  const schedules = (backups ?? []).filter(
    (b) => b?.enabled !== false && b.schedule?.trim(),
  );
  if (schedules.length === 0) return;
  const { createBackup } = await import("../backups/schedules");
  const held = new Set(
    (
      await getDb()
        .select({
          schedule: backupsTable.schedule,
          destinationId: backupsTable.destinationId,
        })
        .from(backupsTable)
        .where(
          target.kind === "app"
            ? eq(backupsTable.appId, target.id)
            : eq(backupsTable.databaseId, target.id),
        )
    ).map((b) => `${b.schedule}|${b.destinationId}`),
  );
  // An app backup covers every volume of the app, so two volumes on one
  // schedule fold into one backup and the note names both.
  const seen = new Map<string, string[]>();
  for (const b of schedules) {
    const schedule = b.schedule!.trim();
    const destName = b.destination?.name?.trim() ?? "";
    const what =
      target.kind === "database"
        ? ""
        : b.volumeName?.trim()
          ? `volume ${b.volumeName.trim()}`
          : b.serviceName?.trim()
            ? `a dump of ${b.serviceName.trim()}`
            : "a dump";
    const key = `${schedule}|${destName.toLowerCase()}`;
    const folded = seen.get(key);
    if (folded) {
      folded.push(what);
      continue;
    }
    seen.set(key, [what]);
    const destinationId = destName
      ? destinations?.get(destName.toLowerCase())
      : undefined;
    const where = `${schedule}${destName ? ` to ${destName}` : ""}`;
    const subject = what ? `${what} was backed up` : "Backed up";
    if (!destinationId) {
      notes.push(
        `${subject} on {panel} (${where}), but that destination is not here, so no schedule was set - set one under Backups.`,
      );
      continue;
    }
    if (held.has(`${schedule}|${destinationId}`)) continue;
    try {
      await createBackup({
        name: `${target.name} to ${destName}`,
        targetKind: target.kind,
        appId: target.kind === "app" ? target.id : null,
        databaseId: target.kind === "database" ? target.id : null,
        destinationId,
        schedule,
        retentionCount:
          typeof b.keepLatestCount === "number" && b.keepLatestCount > 0
            ? b.keepLatestCount
            : 7,
      });
      notes.push(
        what
          ? `Its backup schedule came across: ${where}. Here it backs up every volume of the app, not only ${what}.`
          : `Its backup schedule came across: ${where}.`,
      );
    } catch (e) {
      notes.push(
        `${subject} on {panel} (${where}); the schedule was not set here: ${
          e instanceof Error ? e.message : "refused"
        }. Set one under Backups.`,
      );
    }
  }
  if (target.kind === "app")
    for (const [key, whats] of seen)
      if (whats.length > 1)
        notes.push(
          `${whats.join(", ")} shared the schedule ${key.split("|")[0]} on {panel}; one app backup here covers them all.`,
        );
}

// The S3 stores the panel backed up to, as Deplo's own destinations. Tried at once,
// exactly as a hand-made one is: a credential that stopped working over there should
// say so now, not at the first backup that needed it.
export async function importBackupDestinations(
  c: SourceCredential,
  report: Report,
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let stores: Awaited<
    ReturnType<MigrationSourceClient["listBackupDestinations"]>
  >;
  try {
    stores = await sourceClient(c).listBackupDestinations();
  } catch (e) {
    // Said, not swallowed: every schedule below then reads "that destination is
    // not here" with no line saying why.
    await report.add({
      sourceKind: "destination",
      sourceName: "backup destinations",
      outcome: "manual",
      targetKind: "destination",
      message: `{panel} would not answer for its backup stores (${e instanceof Error ? e.message : "refused"}), so no backup destination came across. Add it under Backups, then the schedules.`,
    });
    return byName;
  }
  if (stores.length === 0) return byName;

  const { createDestination } = await import("../destinations/create");
  const { listDestinations } = await import("../destinations/listing");
  const { testDestination } = await import("../destinations/probe");
  // The bucket is the identity: a store already here under any name is the one
  // the panel's schedules meant, so its name here answers for the panel's.
  const existing = new Map<string, string>(
    (await listDestinations()).map((d) => [
      `${(d.endpoint ?? "").toLowerCase()}|${d.bucket ?? ""}`,
      d.id,
    ]),
  );

  for (const store of stores) {
    const key = `${store.endpoint.toLowerCase()}|${store.bucket}`;
    const already = existing.get(key);
    if (already) {
      byName.set(store.name.toLowerCase(), already);
      await report.add({
        sourceKind: "destination",
        sourceName: store.name,
        outcome: "skipped",
        targetKind: "destination",
        message:
          "A backup destination for that bucket is already in this team.",
      });
      continue;
    }
    try {
      const created = await createDestination({
        name: store.name,
        kind: "s3",
        endpoint: store.endpoint,
        region: store.region,
        bucket: store.bucket,
        accessKey: store.accessKeyId,
        secretKey: store.secretAccessKey,
      });
      existing.set(key, created.id);
      byName.set(store.name.toLowerCase(), created.id);
      let failure: string | null = null;
      try {
        const { report: probe } = await testDestination(created.id);
        failure = probe.ok ? null : probe.error || "it did not answer";
      } catch (e) {
        failure = e instanceof Error ? e.message : "the test did not run";
      }
      await report.add({
        sourceKind: "destination",
        sourceName: store.name,
        outcome: failure ? "manual" : "created",
        targetKind: "destination",
        targetId: created.id,
        message: failure
          ? `It came across, but it did not answer: ${failure}. Those credentials were already dead on {panel} - fix them under Backups.`
          : null,
      });
    } catch (e) {
      await report.add({
        sourceKind: "destination",
        sourceName: store.name,
        outcome: "failed",
        targetKind: "destination",
        message: e instanceof Error ? e.message : "Could not be created.",
      });
    }
  }
  return byName;
}
