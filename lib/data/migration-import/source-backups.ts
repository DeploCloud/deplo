import "server-only";

import { and, eq } from "drizzle-orm";
import { blocker, type Note } from "../../migration/note";

import { getDb } from "../../db/client";
import {
  backupDestination as destTable,
  backupRuns as backupRunsTable,
  backups as backupsTable,
} from "../../db/schema/control-plane/backups";
import { encryptSecret, tryDecryptSecret } from "../../crypto";
import { newId } from "../../ids";
import { requireActiveTeamId } from "../../membership";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import type {
  SourceBackupDestination,
  SourceBackupRun,
  SourceBackupSchedule,
  SourceS3Destination,
  SourceServerDestination,
} from "../../migration/model";
import type { S3Provider } from "../../types/backup";
import type { Report } from "./run-report";

// A destination here, by the source's name for it. `copiedFrom` set: its restore points open here.
export interface LandedDestination {
  id: string;
  copiedFrom: string | null;
  why: string;
}
export type LandedDestinations = Map<string, LandedDestination>;

type BackupTarget = { kind: "app" | "database"; id: string; name: string };

export async function landSourceBackups(
  backups: SourceBackupSchedule[] | null | undefined,
  destinations: LandedDestinations | undefined,
  target: BackupTarget,
  notes: Note[],
  runs?: SourceBackupRun[] | null,
): Promise<void> {
  const schedules = (backups ?? []).filter((b) => b?.schedule?.trim());
  if (schedules.length > 0)
    await landSchedules(schedules, destinations, target, notes);
  if (runs?.length) await landRestorePoints(runs, destinations, target, notes);
}

async function landSchedules(
  schedules: SourceBackupSchedule[],
  destinations: LandedDestinations | undefined,
  target: BackupTarget,
  notes: Note[],
): Promise<void> {
  const { createBackup, toggleBackup } = await import("../backups/schedules");
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
      ? destinations?.get(destName.toLowerCase())?.id
      : undefined;
    const where = `${schedule}${destName ? ` to ${destName}` : ""}`;
    const subject = what ? `${what} was backed up` : "Backed up";
    if (!destinationId) {
      notes.push(
        blocker(
          `${subject} on {panel} (${where}), but that destination is not here, so no schedule was set - set one under Backups.`,
        ),
      );
      continue;
    }
    if (held.has(`${schedule}|${destinationId}`)) continue;
    const paused = b.enabled === false;
    try {
      const created = await createBackup({
        name: `${target.name} to ${destName}`,
        targetKind: target.kind,
        appId: target.kind === "app" ? target.id : null,
        databaseId: target.kind === "database" ? target.id : null,
        destinationId,
        schedule,
        timezone: b.timezone,
        retentionCount:
          typeof b.keepLatestCount === "number" && b.keepLatestCount > 0
            ? b.keepLatestCount
            : 7,
      });
      if (paused) await toggleBackup(created.id, false);
      const came = paused
        ? "Its backup schedule came across paused, as it was"
        : "Its backup schedule came across";
      notes.push(
        what
          ? `${came}: ${where}. Here it backs up every volume of the app, not only ${what}.`
          : `${came}: ${where}.`,
      );
    } catch (e) {
      notes.push(
        blocker(
          `${subject} on {panel} (${where}); the schedule was not set here: ${
            e instanceof Error ? e.message : "refused"
          }. Set one under Backups.`,
        ),
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

async function landRestorePoints(
  runs: SourceBackupRun[],
  destinations: LandedDestinations | undefined,
  target: BackupTarget,
  notes: Note[],
): Promise<void> {
  const teamId = await requireActiveTeamId();
  const byDest = new Map<string, SourceBackupRun[]>();
  for (const r of runs) {
    const name = r.destination?.trim();
    if (!name || !r.objectKey) continue;
    byDest.set(name, [...(byDest.get(name) ?? []), r]);
  }
  for (const [name, points] of byDest) {
    const dest = destinations?.get(name.toLowerCase());
    const count = `${points.length} restore point${points.length === 1 ? "" : "s"} on ${name}`;
    if (!dest?.copiedFrom) {
      notes.push(
        blocker(
          `${count} did not come across: ${dest?.why ?? "that destination is not here. Restore from {panel}."}`,
        ),
      );
      continue;
    }
    const held = new Set(
      (
        await getDb()
          .select({ objectKey: backupRunsTable.objectKey })
          .from(backupRunsTable)
          .where(
            and(
              eq(backupRunsTable.teamId, teamId),
              eq(backupRunsTable.destinationId, dest.id),
              eq(backupRunsTable.targetId, target.id),
            ),
          )
      ).map((r) => r.objectKey),
    );
    const fresh = points.filter((p) => !held.has(p.objectKey));
    // ADR-0035: a copied run is never pruned here, and deleting it forgets the row only.
    if (fresh.length > 0)
      await getDb()
        .insert(backupRunsTable)
        .values(
          fresh.map((p) => ({
            id: newId("brun"),
            teamId,
            backupId: null,
            copiedFrom: dest.copiedFrom,
            targetKind: target.kind,
            appId: target.kind === "app" ? target.id : null,
            databaseId: target.kind === "database" ? target.id : null,
            destinationId: dest.id,
            targetId: target.id,
            objectKey: p.objectKey,
            sizeBytes: p.sizeBytes,
            decryptedSizeBytes: p.decryptedSizeBytes ?? null,
            sha256: p.sha256 ?? null,
            status: "success",
            startedAt: p.startedAt,
            finishedAt: p.finishedAt ?? null,
          })),
        );
    const latest = points
      .map((p) => p.startedAt)
      .sort()
      .at(-1)!
      .slice(0, 10);
    notes.push(
      `${count} came across (latest ${latest}). They stay where {panel} wrote them, so removing one here only forgets it.`,
    );
  }
}

const S3_PROVIDERS: S3Provider[] = [
  "aws",
  "cloudflare-r2",
  "backblaze-b2",
  "minio",
  "digitalocean",
  "wasabi",
  "other",
];

type DestinationRow = typeof destTable.$inferSelect;

const keyOf = (row: DestinationRow): string | null =>
  row.ageIdentityEnc
    ? (() => {
        const res = tryDecryptSecret(row.ageIdentityEnc);
        return res.ok ? res.value : "";
      })()
    : null;

// The artifacts already written open only with the key they were written to.
async function adoptKey(id: string, identity: string | null): Promise<void> {
  let ageRecipient: string | null = null;
  if (identity) {
    const age = await import("age-encryption");
    ageRecipient = await age.identityToRecipient(identity);
  }
  await getDb()
    .update(destTable)
    .set({
      ageRecipient,
      ageIdentityEnc: identity ? encryptSecret(identity) : null,
    })
    .where(eq(destTable.id, id));
}

export async function importBackupDestinations(
  c: SourceCredential,
  report: Report,
  serverFor: (
    sourceServerId: string,
  ) => Promise<string | undefined> = async () => undefined,
): Promise<LandedDestinations> {
  const byName: LandedDestinations = new Map();
  let stores: SourceBackupDestination[];
  try {
    stores = await sourceClient(c).listBackupDestinations();
  } catch (e) {
    await report.add({
      sourceKind: "destination",
      sourceName: "backup destinations",
      outcome: "manual",
      blocking: true,
      targetKind: "destination",
      message: `{panel} would not answer for its backup stores (${e instanceof Error ? e.message : "refused"}), so no backup destination came across. Add it under Backups, then the schedules.`,
    });
    return byName;
  }
  if (stores.length === 0) return byName;

  const teamId = await requireActiveTeamId();
  const here = await getDb()
    .select()
    .from(destTable)
    .where(eq(destTable.teamId, teamId));
  const ctx: LandContext = { c, report, here, byName, serverFor };
  for (const store of stores)
    if (store.kind === "server") await landServerStore(store, ctx);
    else await landBucket(store, ctx);
  return byName;
}

interface LandContext {
  c: SourceCredential;
  report: Report;
  here: DestinationRow[];
  byName: LandedDestinations;
  serverFor: (sourceServerId: string) => Promise<string | undefined>;
}

async function landBucket(
  store: SourceS3Destination,
  ctx: LandContext,
): Promise<void> {
  const already = ctx.here.find(
    (d) =>
      d.kind === "s3" &&
      (d.endpoint ?? "").toLowerCase() === store.endpoint.toLowerCase() &&
      (d.bucket ?? "") === store.bucket,
  );
  if (already) {
    const sameKey =
      store.ageIdentity !== undefined && keyOf(already) === store.ageIdentity;
    ctx.byName.set(store.name.toLowerCase(), {
      id: already.id,
      copiedFrom: sameKey ? ctx.c.baseUrl : null,
      why: sameKey
        ? ""
        : `${already.name}, the destination here for that bucket, encrypts with a different key, so they would not open here. Restore from {panel}.`,
    });
    await ctx.report.add({
      sourceKind: "destination",
      sourceName: store.name,
      outcome: "skipped",
      targetKind: "destination",
      targetId: already.id,
      message: "A backup destination for that bucket is already in this team.",
    });
    return;
  }
  const provider = S3_PROVIDERS.find((p) => p === store.provider) ?? null;
  await createAndProbe(store, ctx, async (createDestination) => {
    const created = await createDestination({
      name: store.name,
      kind: "s3",
      provider,
      endpoint: store.endpoint,
      region: store.region,
      bucket: store.bucket,
      accessKey: store.accessKeyId,
      secretKey: store.secretAccessKey,
    });
    let copiedFrom: string | null = null;
    let why =
      "{panel} did not send the key they are encrypted with. Restore from {panel}.";
    if (store.ageIdentity !== undefined)
      try {
        await adoptKey(created.id, store.ageIdentity);
        copiedFrom = ctx.c.baseUrl;
      } catch {
        why =
          "the key they are encrypted with would not read here. Restore from {panel}.";
      }
    return { id: created.id, copiedFrom, why, note: null };
  });
}

async function landServerStore(
  store: SourceServerDestination,
  ctx: LandContext,
): Promise<void> {
  const host = store.serverName?.trim() || "its server";
  const why = `they sit on ${host}'s disk, which only {panel} can reach. Restore from {panel}, and keep that server until you no longer need them.`;
  const serverId = await ctx.serverFor(store.serverId);
  if (!serverId) {
    await ctx.report.add({
      sourceKind: "destination",
      sourceName: store.name,
      outcome: "manual",
      blocking: true,
      targetKind: "destination",
      message: `It kept backups on ${host}'s disk on {panel}, and no server here was picked for it. Add a destination on one under Backups, then the schedules.`,
    });
    return;
  }
  const already = ctx.here.find(
    (d) =>
      d.kind === "server" &&
      d.serverId === serverId &&
      (d.path ?? null) === (store.path ?? null),
  );
  if (already) {
    ctx.byName.set(store.name.toLowerCase(), {
      id: already.id,
      copiedFrom: null,
      why,
    });
    await ctx.report.add({
      sourceKind: "destination",
      sourceName: store.name,
      outcome: "skipped",
      targetKind: "destination",
      targetId: already.id,
      message: "A backup destination on that server is already in this team.",
    });
    return;
  }
  await createAndProbe(store, ctx, async (createDestination) => {
    const created = await createDestination({
      name: store.name,
      kind: "server",
      serverId,
      path: store.path,
    });
    if (store.ageIdentity)
      await adoptKey(created.id, store.ageIdentity).catch(() => {});
    return {
      id: created.id,
      copiedFrom: null,
      why,
      note: `It starts empty here: the restore points already on ${host}'s disk stay with {panel}.`,
    };
  });
}

async function createAndProbe(
  store: SourceBackupDestination,
  ctx: LandContext,
  create: (
    createDestination: typeof import("../destinations/create").createDestination,
  ) => Promise<LandedDestination & { note: string | null }>,
): Promise<void> {
  const { createDestination } = await import("../destinations/create");
  const { testDestination } = await import("../destinations/probe");
  try {
    const { note, ...landed } = await create(createDestination);
    ctx.byName.set(store.name.toLowerCase(), landed);
    ctx.here.push(
      ...(await getDb()
        .select()
        .from(destTable)
        .where(eq(destTable.id, landed.id))),
    );
    let failure: string | null = null;
    try {
      const { report: probe } = await testDestination(landed.id);
      failure = probe.ok ? null : probe.error || "it did not answer";
    } catch (e) {
      failure = e instanceof Error ? e.message : "the test did not run";
    }
    await ctx.report.add({
      sourceKind: "destination",
      sourceName: store.name,
      outcome: failure ? "manual" : "created",
      targetKind: "destination",
      targetId: landed.id,
      message: failure
        ? `It came across, but it did not answer: ${failure}. ${
            store.kind === "server"
              ? "Check that server under Servers."
              : "Those credentials were already dead on {panel} - fix them under Backups."
          }`
        : note,
    });
  } catch (e) {
    await ctx.report.add({
      sourceKind: "destination",
      sourceName: store.name,
      outcome: "failed",
      targetKind: "destination",
      message: e instanceof Error ? e.message : "Could not be created.",
    });
  }
}
