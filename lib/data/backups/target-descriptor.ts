import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { assembleDatabase } from "../backup-rows";
import { loadTeamApp } from "../app-graph-load";
import { decryptSecretOrThrow } from "../../crypto";
import { parseConnectionPassword } from "../../deploy/database-compose";
import { deployNetwork } from "../../deploy/network";
import { retargetStackNetwork } from "../../deploy/compose-stack/stack-network";
import {
  buildProjectDescriptor,
  type ProjectBackupDescriptor,
} from "../project-backup-descriptor";
import type {
  DatabaseDescriptor,
  ProjectDescriptor,
} from "../../agent/gen/agent";
import type { BackupTargetKind } from "../../types/backup";
import type { Database, DatabaseType } from "../../types/database";

export function dumpUserFor(db: Database): string {
  switch (db.type) {
    case "mysql":
    case "mariadb":
      return "root";
    case "postgres":
    case "mongodb":
    case "redis":
    case "clickhouse":
      return db.username;
  }
}

export function databaseDescriptor(db: Database): DatabaseDescriptor {
  return {
    container: db.host,
    dbType: db.type,
    dbName: db.dbName,
    user: dumpUserFor(db),
    password: parseConnectionPassword(
      decryptSecretOrThrow(db.connectionStringEnc, "The database password"),
    ),
  };
}

export function toWireProjectDescriptor(
  d: ProjectBackupDescriptor,
  network: string,
): ProjectDescriptor {
  return {
    slug: d.slug,
    volumeNames: d.volumeNames,
    includeFiles: d.includeFiles,
    composeYaml: retargetStackNetwork(d.composeYaml, network),
    envSnapshot: d.envSnapshot,
    mounts: d.mounts,
    network,
  };
}

export interface ResolvedTarget {
  serverId: string;
  kind: BackupTargetKind;
  targetId: string;
  databaseId: string | null;
  appId: string | null;
  dbType: DatabaseType | null;
  database?: DatabaseDescriptor;
  project?: ProjectDescriptor;
  label: string;
}

export async function resolveTarget(
  teamId: string,
  kind: BackupTargetKind,
  databaseId: string | null,
  appId: string | null,
): Promise<ResolvedTarget> {
  if (kind === "database") {
    if (!databaseId) throw new Error("Backup has no database target");
    const dbRows = await getDb()
      .select()
      .from(databasesTable)
      .where(
        and(
          eq(databasesTable.id, databaseId),
          eq(databasesTable.teamId, teamId),
        ),
      )
      .limit(1);
    if (!dbRows[0]) throw new Error("Database not found");
    const db = assembleDatabase(dbRows[0]);
    return {
      serverId: db.serverId,
      kind,
      targetId: db.id,
      databaseId: db.id,
      appId: null,
      dbType: db.type,
      database: databaseDescriptor(db),
      label: `database ${db.name}`,
    };
  }
  if (!appId) throw new Error("Backup has no project target");
  const project = await loadTeamApp(appId, teamId);
  if (!project) throw new Error("App not found");
  const descriptor = await buildProjectDescriptor(project);
  return {
    serverId: project.serverId,
    kind,
    targetId: project.id,
    databaseId: null,
    appId: project.id,
    dbType: null,
    project: toWireProjectDescriptor(descriptor, deployNetwork(project)),
    label: `project ${project.name}`,
  };
}
