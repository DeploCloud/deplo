import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backupDestination as destTable,
  backupRuns as backupRunsTable,
  backups as backupsTable,
} from "../../db/schema/control-plane/backups";
import { nextCronRun } from "../../backups/cron";
import {
  FAILOVER_BACKUP_MINUTES,
  FAILOVER_BACKUP_SCHEDULE,
  FAILOVER_PROMISES,
  STANDBY_LOSS,
  STANDBY_PROMISES,
  STANDBY_RECOVERY,
  lossSentence,
  recoverySentence,
} from "../../databases/failover-copy";
import { archivesChangeLog } from "../../databases/change-log";
import {
  STANDBY_ENGINES,
  standbyMembersRefusal,
} from "../../databases/standby";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { isDeploHostServer } from "../../deploy/domains";
import { newId, nowIso } from "../../ids";
import { requireActiveTeamId } from "../../membership";
import { serverLabel, messageOf } from "../../utils";
import { recordActivity } from "../activity";
import {
  assembleBackup,
  assembleDatabase,
  assembleDestination,
  backupToRow,
} from "../backup-rows";
import { notLeftBehind } from "../backups/left-behind";
import { instanceFrozen } from "../deplo-move/freeze";
import { latestBaseBackup } from "../clusters/change-log";
import { standbyMemberOf, waitingForRoomNote } from "../clusters/placement";
import { clusterMemberServerIds, getClusterById } from "../clusters/roster";
import { insertServerDestination } from "../destinations/create";
import { getServerById, listAllServers } from "../servers/roster";
import { loadDatabase } from "./rows";
import type {
  Backup,
  BackupDestination,
  BackupTargetKind,
} from "../../types/backup";
import type { Database } from "../../types/database";

// ponytail: 8 runs is two hours of history; the schedule is editable when a team wants more.
const FAILOVER_BACKUP_KEPT = 8;

type Placed = Pick<
  Database,
  "id" | "teamId" | "name" | "serverId" | "clusterId"
>;

async function teamDestinations(teamId: string): Promise<BackupDestination[]> {
  const rows = await getDb()
    .select()
    .from(destTable)
    .where(eq(destTable.teamId, teamId))
    .orderBy(asc(destTable.createdAt));
  return rows.map(assembleDestination);
}

const FAILOVER_BACKUP_NAME = "Failover backup";

/** What another member can read without the workload's own server: a bucket, or another member's disk. */
function readableByFailover(
  d: { kind: string; serverId?: string | null },
  workloadServerId: string,
  members: string[],
): boolean {
  return (
    d.kind === "s3" ||
    (d.serverId !== workloadServerId && members.includes(d.serverId ?? ""))
  );
}

/**
 * Never the member the workload runs on (ADR-0019): a bucket, another member's disk (a new one when the team has
 * none), and only then a server outside the cluster, which no failover can read.
 */
async function failoverDestination(
  db: Placed & { clusterId: string },
): Promise<BackupDestination | null> {
  const members = await clusterMemberServerIds(db.clusterId);
  const rank = (d: BackupDestination) => (d.kind === "s3" ? 0 : 1);
  const usable = (await teamDestinations(db.teamId))
    .filter(
      (d) =>
        d.status !== "error" && (d.kind === "s3" || d.serverId !== db.serverId),
    )
    .sort((a, b) => rank(a) - rank(b));
  const readable = usable.find((d) =>
    readableByFailover(d, db.serverId, members),
  );
  if (readable) return readable;

  const ready = (await listAllServers()).filter(
    (s) => s.id !== db.serverId && s.agent?.certFingerprint && !s.importOnly,
  );
  // A member that answers before one that does not: a backup that cannot run protects nothing.
  const member = members
    .map((m) => ready.find((s) => s.id === m))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .sort(
      (a, b) => Number(b.status === "online") - Number(a.status === "online"),
    )[0];
  if (member)
    return insertServerDestination(db.teamId, member.id, serverLabel(member));
  if (usable[0]) return usable[0];
  const own = ready.find((s) => isDeploHostServer(s));
  if (!own) return null;
  return insertServerDestination(db.teamId, own.id, serverLabel(own));
}

/**
 * Gives a database on a cluster, or an App that keeps a Volume there, its 15-minute backup, unless it has a
 * schedule. Never throws: placing already happened.
 */
export async function ensureFailoverBackup(
  db: Placed,
  kind: BackupTargetKind = "database",
): Promise<void> {
  const clusterId = db.clusterId;
  if (!clusterId) return;
  const isApp = kind === "app";
  const say = (message: string) =>
    recordActivity(
      "backup",
      message,
      "Deplo",
      isApp ? db.id : null,
      db.teamId,
      null,
      isApp ? null : db.id,
    );
  try {
    const [row] = await getDb()
      .select()
      .from(databasesTable)
      .where(eq(databasesTable.id, db.id))
      .limit(1);
    // Postgres replays its change log onto a base backup, which only this schedule writes: its own stay dumps.
    // ponytail: a whole base backup every 15 minutes; a large database wants a rarer one once replay time is measured.
    const base =
      !!row && archivesChangeLog({ ...assembleDatabase(row), clusterId });
    const members = await clusterMemberServerIds(clusterId);
    const existing = await getDb()
      .select({
        name: backupsTable.name,
        enabled: backupsTable.enabled,
        kind: destTable.kind,
        serverId: destTable.serverId,
      })
      .from(backupsTable)
      .innerJoin(destTable, eq(destTable.id, backupsTable.destinationId))
      .where(
        and(
          eq(isApp ? backupsTable.appId : backupsTable.databaseId, db.id),
          base ? eq(backupsTable.baseBackup, true) : undefined,
        ),
      );
    // One a failover can use, or Deplo's own: never made twice, and left alone when the team switched it off.
    if (
      existing.some(
        (b) =>
          b.name === FAILOVER_BACKUP_NAME ||
          (b.enabled && readableByFailover(b, db.serverId, members)),
      )
    )
      return;
    const dest = await failoverDestination({ ...db, clusterId });
    if (!dest) {
      await say(
        `${db.name} has no backup: there is no other server to keep one on. Add a server to its cluster or a backup destination.`,
      );
      return;
    }
    const b: Backup = {
      id: newId("bkp"),
      teamId: db.teamId,
      name: FAILOVER_BACKUP_NAME,
      targetKind: kind,
      databaseId: isApp ? null : db.id,
      appId: isApp ? db.id : null,
      destinationId: dest.id,
      schedule: FAILOVER_BACKUP_SCHEDULE,
      timezone: "UTC",
      retentionCount: FAILOVER_BACKUP_KEPT,
      lastRunAt: null,
      lastStatus: "never",
      enabled: true,
      baseBackup: base,
      createdAt: nowIso(),
    };
    await getDb().insert(backupsTable).values(backupToRow(b));
    await say(
      `Backs up ${db.name} every ${FAILOVER_BACKUP_MINUTES} minutes to ${dest.name}` +
        // A database is dumped while it runs; an App's files are only whole while nothing writes them.
        (isApp
          ? `. ${db.name} pauses while each backup is taken, so its files are copied whole.`
          : ""),
    );
  } catch (e) {
    await say(`Could not set up ${db.name}'s backup: ${messageOf(e)}`);
  }
}

/**
 * Deplo's own backup follows its workload: one kept on the server the workload now runs on, or on a server outside
 * the cluster, moves to where a failover can read it. A schedule the team made itself is never touched.
 */
export async function rehomeFailoverBackups(clusterId: string): Promise<void> {
  const members = await clusterMemberServerIds(clusterId);
  const rows = await getDb()
    .select({
      id: backupsTable.id,
      teamId: backupsTable.teamId,
      appId: backupsTable.appId,
      databaseId: backupsTable.databaseId,
      destKind: destTable.kind,
      destServerId: destTable.serverId,
      destId: destTable.id,
    })
    .from(backupsTable)
    .innerJoin(destTable, eq(destTable.id, backupsTable.destinationId))
    .where(eq(backupsTable.name, FAILOVER_BACKUP_NAME));
  for (const b of rows) {
    const [w] = b.databaseId
      ? await getDb()
          .select({
            id: databasesTable.id,
            teamId: databasesTable.teamId,
            name: databasesTable.name,
            serverId: databasesTable.serverId,
            clusterId: databasesTable.clusterId,
          })
          .from(databasesTable)
          .where(eq(databasesTable.id, b.databaseId))
      : await getDb()
          .select({
            id: appsTable.id,
            teamId: appsTable.teamId,
            name: appsTable.name,
            serverId: appsTable.serverId,
            clusterId: appsTable.clusterId,
          })
          .from(appsTable)
          .where(eq(appsTable.id, b.appId ?? ""));
    if (!w || w.clusterId !== clusterId || w.teamId !== b.teamId) continue;
    const kept = { kind: b.destKind, serverId: b.destServerId };
    if (readableByFailover(kept, w.serverId, members)) continue;
    const next = await failoverDestination({ ...w, clusterId });
    if (!next || next.id === b.destId) continue;
    if (!readableByFailover(next, w.serverId, members)) continue;
    // Never onto a server that is down: the backup that still runs is worth more.
    if (
      next.kind === "server" &&
      (await getServerById(next.serverId ?? ""))?.status !== "online"
    )
      continue;
    await getDb()
      .update(backupsTable)
      .set({ destinationId: next.id })
      .where(and(eq(backupsTable.id, b.id), eq(backupsTable.teamId, w.teamId)));
    const here = (await getServerById(w.serverId))?.name ?? "its server";
    await recordActivity(
      "backup",
      `Backs up ${w.name} every ${FAILOVER_BACKUP_MINUTES} minutes to ${next.name} from now on: ` +
        (b.destServerId === w.serverId
          ? `${w.name} now runs on ${here}, where its backups were kept.`
          : "its backups were kept on a server outside its cluster, where a failover cannot read them."),
      "Deplo",
      b.appId,
      w.teamId,
      null,
      b.databaseId,
    );
  }
}

/** The sweep's job: a cluster that grew, or a failover Deplo slept through, still ends with a readable backup. */
export async function reconcileFailoverBackupHomes(): Promise<void> {
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  for (const c of rows) {
    if (await instanceFrozen()) return;
    await rehomeFailoverBackups(c.id);
  }
}

function minutesBetweenRuns(schedule: string): number | null {
  const first = nextCronRun(schedule, new Date());
  const second = first && nextCronRun(schedule, first);
  return second ? (second.getTime() - first!.getTime()) / 60_000 : null;
}

async function lossAndRecovery(
  db: Database,
  schedules: Backup[],
): Promise<{ loss: string; recovery: string }> {
  const windows = schedules
    .filter((s) => s.enabled)
    .map((s) => minutesBetweenRuns(s.schedule))
    .filter((m): m is number => m != null);
  const archived =
    archivesChangeLog(db) &&
    !!db.walArchivedAt &&
    !!(await latestBaseBackup(db));
  const last = await getDb()
    .select({ sizeBytes: backupRunsTable.sizeBytes })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, db.teamId),
        eq(backupRunsTable.databaseId, db.id),
        eq(backupRunsTable.status, "success"),
        notLeftBehind,
      ),
    )
    .orderBy(desc(backupRunsTable.seq))
    .limit(1);
  return {
    loss: lossSentence(
      windows.length > 0 ? Math.min(...windows) : null,
      archived,
    ),
    recovery: recoverySentence(
      last[0]?.sizeBytes ?? null,
      db.restoreBytesPerSec ?? null,
    ),
  };
}

async function schedulesOf(db: Database): Promise<Backup[]> {
  const rows = await getDb()
    .select()
    .from(backupsTable)
    .where(
      and(
        eq(backupsTable.teamId, db.teamId),
        eq(backupsTable.databaseId, db.id),
      ),
    )
    .orderBy(asc(backupsTable.createdAt));
  return rows.map(assembleBackup);
}

export interface FailoverPreview {
  promises: readonly string[];
  loss: string;
  recovery: string;
}

/** What placing this database on a cluster would promise, for the dialog that offers it. */
export async function getFailoverPreview(
  id: string,
): Promise<FailoverPreview | null> {
  const db = await loadDatabase(id, await requireActiveTeamId(), {
    forRead: true,
  });
  if (!db) return null;
  // The switch travels with the database from one cluster to another, so the offer already counts on its copy.
  if (db.standby)
    return {
      promises: STANDBY_PROMISES,
      loss: STANDBY_LOSS,
      recovery: STANDBY_RECOVERY,
    };
  const schedules = await schedulesOf(db);
  const copy = await lossAndRecovery(db, schedules);
  return {
    promises: FAILOVER_PROMISES,
    // Placing creates the 15-minute schedule when there is none, and starts archiving a Postgres change log.
    loss: archivesChangeLog({ ...db, clusterId: db.clusterId ?? "placed" })
      ? lossSentence(FAILOVER_BACKUP_MINUTES, true)
      : schedules.length === 0
        ? lossSentence(FAILOVER_BACKUP_MINUTES)
        : copy.loss,
    recovery: copy.recovery,
  };
}

export interface DatabaseFailover extends FailoverPreview {
  cluster: string;
  /** The member it runs on now. */
  serverName: string;
  /** Where its backups go; null with none scheduled. */
  destination: string | null;
  /** Set when it runs on the server its backups are kept on. */
  warning: string | null;
  /** "Waiting for room in eu" while no server of the cluster runs it. */
  waiting: string | null;
  /** The server holding its standby copy; null with none. */
  standbyOn: string | null;
  /** Set while the switch is on and no copy exists: a failover would restore a backup. */
  standbyNote: string | null;
}

/** What a database on a cluster relies on, as its page states it; null for a database on one server. */
export async function getDatabaseFailover(
  id: string,
): Promise<DatabaseFailover | null> {
  const db = await loadDatabase(id, await requireActiveTeamId(), {
    forRead: true,
  });
  if (!db?.clusterId) return null;
  const cluster = await getClusterById(db.clusterId);
  if (!cluster) return null;
  const schedules = (await schedulesOf(db)).filter((s) => s.enabled);
  const destinations =
    schedules.length === 0
      ? []
      : (
          await getDb()
            .select()
            .from(destTable)
            .where(
              inArray(
                destTable.id,
                schedules.map((s) => s.destinationId),
              ),
            )
        ).map(assembleDestination);
  const serverName = (await getServerById(db.serverId))?.name ?? "its server";
  const onSameServer = destinations.some(
    (d) => d.kind === "server" && d.serverId === db.serverId,
  );
  const copyOn = db.standby ? await standbyMemberOf(db.id) : null;
  const engine = STANDBY_ENGINES[db.type];
  const small =
    db.standby && engine
      ? standbyMembersRefusal(engine, {
          cluster: cluster.name,
          name: db.name,
          members: (await clusterMemberServerIds(cluster.id)).length,
        })
      : null;
  const standbyOn =
    copyOn && copyOn !== db.serverId
      ? ((await getServerById(copyOn))?.name ?? "another server")
      : null;
  return {
    cluster: cluster.name,
    serverName,
    standbyOn,
    standbyNote:
      db.standby && !standbyOn
        ? `There is no standby copy right now, so a failover restores the latest backup. ${small ?? "Deplo makes a new copy as soon as another server has room."}`
        : null,
    ...(standbyOn
      ? {
          promises: STANDBY_PROMISES,
          loss: STANDBY_LOSS,
          recovery: STANDBY_RECOVERY,
        }
      : {
          promises: FAILOVER_PROMISES,
          ...(await lossAndRecovery(db, schedules)),
        }),
    destination:
      destinations.find((d) => d.id === schedules[0]?.destinationId)?.name ??
      null,
    waiting: await waitingForRoomNote(db.id, cluster.name, "database"),
    warning: onSameServer
      ? `${db.name} now runs on ${serverName}, the server its backups are kept on. If ${serverName} stops, the backups go with it. Pick another destination for its backup.`
      : null,
  };
}
