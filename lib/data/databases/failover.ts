import "server-only";

import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backupDestination as destTable,
  backupRuns as backupRunsTable,
  backups as backupsTable,
} from "../../db/schema/control-plane/backups";
import { nextCronRun } from "../../backups/cron";
import { describeCron } from "../../schedule";
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
import {
  clusterMembers as membersTable,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
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
import { FULL_SHARE, diskFull } from "../backups/room";
import { instanceFrozen } from "../deplo-move/freeze";
import { latestBaseBackup } from "../clusters/change-log";
import { latestDisk } from "../clusters/facts";
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

/** Members whose removal has started: never a backup's home from then on, even while it is stopped (c50). */
async function leavingServerIds(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ id: membersTable.serverId })
    .from(membersTable)
    .where(isNotNull(membersTable.emptyingSince));
  return new Set(rows.map((r) => r.id));
}

/** The cluster's members that stay: where a failover backup may live. */
async function stayingMembers(clusterId: string): Promise<string[]> {
  const leaving = await leavingServerIds();
  return (await clusterMemberServerIds(clusterId)).filter(
    (m) => !leaving.has(m),
  );
}

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
 * Each server's free disk less what Deplo's own backups kept there will still write before their retention is full;
 * null when its disk is unknown. `except` is the workload choosing, whose own backups do not count.
 */
async function backupRoom(
  serverIds: string[],
  except: string,
): Promise<Map<string, number | null>> {
  const rows =
    serverIds.length === 0
      ? []
      : await getDb()
          .select({
            keep: backupsTable.retentionCount,
            serverId: destTable.serverId,
            destId: destTable.id,
            appId: backupsTable.appId,
            databaseId: backupsTable.databaseId,
          })
          .from(backupsTable)
          .innerJoin(destTable, eq(destTable.id, backupsTable.destinationId))
          .where(
            and(
              eq(backupsTable.name, FAILOVER_BACKUP_NAME),
              inArray(destTable.serverId, serverIds),
            ),
          );
  const schedules = rows
    .map((r) => ({ ...r, target: r.appId ?? r.databaseId ?? "" }))
    .filter((r) => r.target && r.target !== except);
  const runs =
    schedules.length === 0
      ? []
      : await getDb()
          .select({
            targetId: backupRunsTable.targetId,
            destId: backupRunsTable.destinationId,
            size: backupRunsTable.sizeBytes,
          })
          .from(backupRunsTable)
          .where(
            and(
              inArray(
                backupRunsTable.targetId,
                schedules.map((r) => r.target),
              ),
              eq(backupRunsTable.status, "success"),
            ),
          )
          .orderBy(desc(backupRunsTable.startedAt));
  const pending = new Map<string, number>();
  for (const s of schedules) {
    const own = runs.filter((r) => r.targetId === s.target);
    const kept = own.filter((r) => r.destId === s.destId).length;
    const more = Math.max(0, s.keep - kept) * (own[0]?.size ?? 0);
    pending.set(s.serverId!, (pending.get(s.serverId!) ?? 0) + more);
  }
  return new Map(
    serverIds.map((id) => {
      const d = latestDisk(id);
      return [id, d.total > 0 ? d.free - (pending.get(id) ?? 0) : null];
    }),
  );
}

/**
 * Never the member the workload runs on (ADR-0019): a bucket, else the other member with the most room for backups
 * (its own destination, or a new one), and only then a server outside the cluster, which no failover can read.
 */
async function failoverDestination(
  db: Placed & { clusterId: string },
): Promise<BackupDestination | null> {
  const leaving = await leavingServerIds();
  const members = await stayingMembers(db.clusterId);
  const usable = (await teamDestinations(db.teamId)).filter(
    (d) =>
      d.status !== "error" &&
      (d.kind === "s3" ||
        (d.serverId !== db.serverId && !leaving.has(d.serverId ?? ""))),
  );
  const bucket = usable.find((d) => d.kind === "s3");
  if (bucket) return bucket;

  const ready = (await listAllServers()).filter(
    (s) =>
      s.id !== db.serverId &&
      !leaving.has(s.id) &&
      s.agent?.certFingerprint &&
      !s.importOnly,
  );
  const others = members
    .map((m) => ready.find((s) => s.id === m))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  const room = await backupRoom(
    others.map((s) => s.id),
    db.id,
  );
  const roomOf = (id: string) => room.get(id) ?? -Infinity;
  const kept = (id: string) =>
    Number(usable.some((d) => d.kind === "server" && d.serverId === id));
  // A member that answers first (a backup that cannot run protects nothing), then the most room, then one in use.
  const member = others.sort(
    (a, b) =>
      Number(b.status === "online") - Number(a.status === "online") ||
      roomOf(b.id) - roomOf(a.id) ||
      kept(b.id) - kept(a.id),
  )[0];
  if (member)
    return (
      usable.find((d) => d.kind === "server" && d.serverId === member.id) ??
      insertServerDestination(db.teamId, member.id, serverLabel(member))
    );
  if (usable[0]) return usable[0];
  const own = ready.find((s) => isDeploHostServer(s));
  if (!own) return null;
  return insertServerDestination(db.teamId, own.id, serverLabel(own));
}

/** One of the database's enabled schedules writes where a failover can read: its next run hands the leader a backup. */
export async function backsUpForFailover(db: Placed): Promise<boolean> {
  if (!db.clusterId) return false;
  const members = await clusterMemberServerIds(db.clusterId);
  const rows = await getDb()
    .select({ kind: destTable.kind, serverId: destTable.serverId })
    .from(backupsTable)
    .innerJoin(destTable, eq(destTable.id, backupsTable.destinationId))
    .where(
      and(eq(backupsTable.databaseId, db.id), eq(backupsTable.enabled, true)),
    );
  return rows.some((d) => readableByFailover(d, db.serverId, members));
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
 * Deplo's own backup follows its workload: one kept on the server it now runs on, outside the cluster, or on a disk
 * past 80% used, moves to where a failover can read it. A schedule the team made itself is never touched.
 */
export async function rehomeFailoverBackups(clusterId: string): Promise<void> {
  const leaving = await leavingServerIds();
  const members = await stayingMembers(clusterId);
  const rows = await getDb()
    .select({
      id: backupsTable.id,
      teamId: backupsTable.teamId,
      appId: backupsTable.appId,
      databaseId: backupsTable.databaseId,
      schedule: backupsTable.schedule,
      timezone: backupsTable.timezone,
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
            moving: appsTable.migrateFromServerId,
          })
          .from(appsTable)
          .where(eq(appsTable.id, b.appId ?? ""));
    if (!w || w.clusterId !== clusterId || w.teamId !== b.teamId) continue;
    // Its serverId is only where a move goes: one rolled back would have moved its backups for nothing.
    if ("moving" in w && w.moving) continue;
    const kept = { kind: b.destKind, serverId: b.destServerId };
    const full = b.destKind === "server" && diskFull(b.destServerId);
    if (readableByFailover(kept, w.serverId, members) && !full) continue;
    const next = await failoverDestination({ ...w, clusterId });
    if (!next || next.id === b.destId) continue;
    if (!readableByFailover(next, w.serverId, members)) continue;
    if (full && next.kind === "server" && diskFull(next.serverId)) continue;
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
    const when = describeCron(b.schedule, { timeZone: b.timezone });
    await recordActivity(
      "backup",
      `Backs up ${w.name} ${when ? when[0]!.toLowerCase() + when.slice(1) : "on its schedule"} to ${next.name} from now on: ` +
        (b.destServerId === w.serverId
          ? `${w.name} now runs on ${here}, where its backups were kept.`
          : leaving.has(b.destServerId ?? "")
            ? `${(await getServerById(b.destServerId ?? ""))?.name ?? "the server that kept them"} is leaving cluster ${(await getClusterById(clusterId))?.name ?? "its cluster"}.`
            : full
              ? `${(await getServerById(b.destServerId ?? ""))?.name ?? "the server that kept them"} is more than ${FULL_SHARE * 100}% full.`
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
