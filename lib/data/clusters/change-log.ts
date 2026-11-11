import "server-only";

import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";

import { PostgresArchive } from "../../agent/gen/agent";
import { getDb } from "../../db/client";
import { backupRuns as runsTable } from "../../db/schema/control-plane/backups";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  CHANGE_LOG_KEPT_MINUTES,
  archivesChangeLog,
} from "../../databases/change-log";
import { connectAgent } from "../../infra/agent-client/connect";
import { BACKUP_RUN_MAX_MS } from "../../infra/agent-client/deadlines";
import type { Database } from "../../types/database";
import { changeLogKey, isBaseBackupKey } from "../backup-objectkey";
import { assembleDatabase } from "../backup-rows";
import { backupToDestination } from "../backup-transport";
import { databaseDescriptor } from "../backups/target-descriptor";
import { instanceFrozen } from "../deplo-move/freeze";
import { getDestinationWithSecretsForTeam } from "../destinations/credentials";

// Postgres on a cluster leaves each finished piece of its change log on its member; this collects them into the
// folder beside the latest base backup. https://deplo.build/docs/operations/clusters#databases

const KEPT_MS = CHANGE_LOG_KEPT_MINUTES * 60_000;

// Since when each database's stack was seen archiving, while its change log is not counted yet.
const watching = new Map<string, number>();

/** The newest finished base backup of a database: its change log is kept beside it and replayed onto it. */
export async function latestBaseBackup(teamId: string, databaseId: string) {
  const runs = await getDb()
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.teamId, teamId),
        eq(runsTable.targetId, databaseId),
        eq(runsTable.status, "success"),
        isNull(runsTable.orphanedAt),
      ),
    )
    .orderBy(desc(runsTable.seq))
    .limit(50);
  return runs.find((r) => isBaseBackupKey(r.objectKey)) ?? null;
}

async function backupRunning(db: Database): Promise<boolean> {
  const [busy] = await getDb()
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(
      and(
        eq(runsTable.targetId, db.id),
        eq(runsTable.status, "running"),
        gt(
          runsTable.startedAt,
          new Date(Date.now() - BACKUP_RUN_MAX_MS).toISOString(),
        ),
      ),
    )
    .limit(1);
  return Boolean(busy);
}

// A database that joined with its server archives only once it restarts on the stack that says so.
async function stackArchives(db: Database): Promise<boolean> {
  const conn = await connectAgent(db.serverId);
  try {
    return (await conn.readStack(db.host)).yaml.includes("archive_mode=on");
  } finally {
    conn.close();
  }
}

/** The database's files were replaced, so what Postgres archives now follows no base backup taken before. */
export async function changeLogBroken(databaseId: string): Promise<void> {
  watching.delete(databaseId);
  await getDb()
    .update(databasesTable)
    .set({ walArchivedAt: null })
    .where(eq(databasesTable.id, databaseId));
}

async function shipOne(db: Database): Promise<void> {
  const at = new Date();
  const counted = db.walArchivedAt ? Date.parse(db.walArchivedAt) : null;
  // What Postgres archives during a backup belongs beside that one, once it is there.
  if (await backupRunning(db)) return;
  if (counted !== null && at.getTime() - counted > KEPT_MS)
    // Postgres dropped what waited that long, so the log has a hole: it counts again after the next base backup.
    return changeLogBroken(db.id);
  const base = await latestBaseBackup(db.teamId, db.id);
  if (counted === null) {
    if (!(await stackArchives(db))) {
      watching.delete(db.id);
      return;
    }
    const since = watching.get(db.id) ?? at.getTime();
    watching.set(db.id, since);
    // Only beside a base backup taken while Postgres was already archiving, before anything waiting was dropped:
    // an older one has a hole between it and this log.
    const taken = base ? Date.parse(base.finishedAt ?? base.startedAt) : 0;
    if (taken < since || at.getTime() - taken > KEPT_MS) return;
  }
  if (!base) return;
  const out = await backupToDestination(
    await getDestinationWithSecretsForTeam(db.teamId, base.destinationId),
    {
      serverId: db.serverId,
      kind: "database",
      database: databaseDescriptor(db),
      archive: PostgresArchive.POSTGRES_ARCHIVE_LOG,
    },
    changeLogKey(base.objectKey, at),
  );
  if (!out.ok) throw new Error(out.error || "the change log was not written");
  watching.delete(db.id);
  await getDb()
    .update(databasesTable)
    .set({ walArchivedAt: at.toISOString() })
    .where(eq(databasesTable.id, db.id));
}

async function shipAll(): Promise<void> {
  if (await instanceFrozen()) return;
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.type, "postgres"),
        isNotNull(databasesTable.clusterId),
      ),
    );
  for (const row of rows) {
    const db = assembleDatabase(row);
    if (!archivesChangeLog(db) || db.status === "provisioning") continue;
    await shipOne(db).catch((e) =>
      console.warn(
        `[change-log] ${db.id}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

let pass: Promise<void> | null = null;

/** Collects the change log of every Postgres database on a cluster; a pass already running is joined, not doubled. */
export function shipChangeLogs(): Promise<void> {
  pass ??= shipAll().finally(() => {
    pass = null;
  });
  return pass;
}

/** Test seam: forget which stacks were seen archiving. */
export function __forgetChangeLogWatchForTest(): void {
  watching.clear();
}
