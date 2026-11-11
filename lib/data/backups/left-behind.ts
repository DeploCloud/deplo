import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { BackupRequest } from "../../agent/gen/agent";
import type { ProjectDescriptor } from "../../agent/gen/agent";
import {
  backupDestination as destTable,
  backupRuns as backupRunsTable,
  backups as backupsTable,
} from "../../db/schema/control-plane/backups";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { appNetwork } from "../../deploy/network";
import { newId } from "../../ids";
import type { BackupRun, BackupTargetKind } from "../../types/backup";
import type { Database } from "../../types/database";
import { backupRunToRow } from "../backup-rows";
import { targetPrefix } from "../backup-objectkey";
import { backupRequestFor } from "../backup-transport";
import { getDestinationWithSecretsForTeam } from "../destinations/credentials";
import {
  databasePassword,
  dbVolumeHostName,
  mountFilesFor,
  renderDatabaseStackYaml,
} from "../databases/stack";

// Data a returning cluster member had left is kept as a backup run (spec #176, #206): never pruned by a
// schedule, never restored by Deplo on its own.

/** Every run but the ones a returning member left: what retention counts and a failover restores. */
export const notLeftBehind = isNull(backupRunsTable.leftAt);

/** Where a member writes what it had left: it adds the time and its own id. */
export function leftBehindStem(
  teamId: string,
  kind: BackupTargetKind,
  targetId: string,
): string {
  return `${targetPrefix(teamId, kind, targetId)}left`;
}

/** A database's data as its volume: what a member that no longer runs it archives, and what restores it. */
export function databaseVolumeProject(
  db: Database,
  withStack = false,
): ProjectDescriptor {
  return {
    slug: db.host,
    volumeNames: [dbVolumeHostName(db.host)],
    includeFiles: false,
    composeYaml: withStack
      ? renderDatabaseStackYaml(db, databasePassword(db))
      : "",
    envSnapshot: {},
    mounts: withStack ? mountFilesFor(db) : [],
    network: withStack ? appNetwork(db) : "",
  };
}

/** What a member that comes back is handed to save what it still held of a workload, before it removes it. */
export interface FailoverKeep {
  /** The destination it goes to, said back with what was saved. */
  ref: string;
  /** The member whose disk that destination is on; absent for a bucket every member reaches. */
  storeMember?: string;
  /** The agent's own backup request as JSON, credentials included: the leader passes it on unread. */
  request: unknown;
}

/** The keep of a workload that has a backup schedule: its volumes, archived to that schedule's destination. */
export async function leftBehindKeep(t: {
  teamId: string;
  kind: BackupTargetKind;
  id: string;
  project: ProjectDescriptor;
}): Promise<FailoverKeep | null> {
  const [schedule] = await getDb()
    .select({ destinationId: backupsTable.destinationId })
    .from(backupsTable)
    .where(
      and(
        eq(backupsTable.teamId, t.teamId),
        eq(
          t.kind === "app" ? backupsTable.appId : backupsTable.databaseId,
          t.id,
        ),
        eq(backupsTable.enabled, true),
      ),
    )
    .orderBy(asc(backupsTable.createdAt))
    .limit(1);
  if (!schedule || t.project.volumeNames.length === 0) return null;
  const creds = await getDestinationWithSecretsForTeam(
    t.teamId,
    schedule.destinationId,
  ).catch(() => null);
  if (!creds) return null;
  const dest = creds.destination;
  return {
    ref: dest.id,
    ...(dest.kind === "server" && dest.serverId
      ? { storeMember: dest.serverId }
      : {}),
    request: BackupRequest.toJSON(
      backupRequestFor(
        creds,
        // Volumes only: the stack and its variables are in the bundle, and newer there.
        {
          kind: "app",
          project: {
            ...t.project,
            composeYaml: "",
            envSnapshot: {},
            mounts: [],
          },
        },
        leftBehindStem(t.teamId, t.kind, t.id),
      ),
    ),
  };
}

/** Fills in the name of the server each left-behind run was on. */
export async function withLeftServerNames(
  runs: BackupRun[],
): Promise<BackupRun[]> {
  const ids = [
    ...new Set(
      runs.map((r) => r.leftOnServerId).filter((id): id is string => !!id),
    ),
  ];
  if (ids.length === 0) return runs;
  const rows = await getDb()
    .select({ id: serversTable.id, name: serversTable.name })
    .from(serversTable)
    .where(inArray(serversTable.id, ids));
  const names = new Map(rows.map((s) => [s.id, s.name]));
  return runs.map((r) =>
    r.leftOnServerId
      ? { ...r, leftOnServer: names.get(r.leftOnServerId) ?? null }
      : r,
  );
}

/**
 * Records what a returning member saved. Refused (null) unless the file sits under the workload's own folder
 * in one of its team's destinations: a member never points a run at somebody else's file.
 */
export async function recordLeftBehindRun(input: {
  teamId: string;
  kind: BackupTargetKind;
  targetId: string;
  destinationId: string;
  objectKey: string;
  sizeBytes: number;
  decryptedSizeBytes: number | null;
  sha256: string | null;
  serverId: string;
  failedOverAt: string;
  savedAt: string;
}): Promise<string | null> {
  const db = getDb();
  const stem = leftBehindStem(input.teamId, input.kind, input.targetId);
  if (!input.objectKey.startsWith(`${stem}-`) || input.objectKey.includes(".."))
    return null;
  const [dest] = await db
    .select({ id: destTable.id })
    .from(destTable)
    .where(
      and(
        eq(destTable.id, input.destinationId),
        eq(destTable.teamId, input.teamId),
      ),
    )
    .limit(1);
  if (!dest) return null;
  const [known] = await db
    .select({ id: backupRunsTable.id })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, input.teamId),
        eq(backupRunsTable.objectKey, input.objectKey),
      ),
    )
    .limit(1);
  if (known) return known.id;
  const isApp = input.kind === "app";
  const run: BackupRun = {
    id: newId("brun"),
    teamId: input.teamId,
    backupId: null,
    targetKind: input.kind,
    databaseId: isApp ? null : input.targetId,
    appId: isApp ? input.targetId : null,
    destinationId: input.destinationId,
    targetId: input.targetId,
    objectKey: input.objectKey,
    sizeBytes: input.sizeBytes,
    decryptedSizeBytes: input.decryptedSizeBytes,
    heldMs: null,
    sha256: input.sha256,
    orphanedAt: null,
    leftAt: input.failedOverAt,
    leftOnServerId: input.serverId,
    status: "success",
    error: null,
    startedAt: input.savedAt,
    finishedAt: input.savedAt,
  };
  await db.insert(backupRunsTable).values(backupRunToRow(run));
  return run.id;
}
