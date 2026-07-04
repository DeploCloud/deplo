import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  databases as databasesTable,
  s3Destination as s3Table,
} from "../db/schema/control-plane";
import {
  backupToRow,
  backupRunToRow,
  databaseToRow,
  s3ToRow,
} from "./backup-rows";
import { encryptSecret } from "../crypto";
import type { TestDb } from "../db/test-harness";
import type {
  Backup,
  BackupRun,
  Database,
  S3Destination,
} from "../types";
import { TEAM_A } from "./identity-test-helpers";
import { SERVER_1 } from "./project-graph-test-helpers";

/**
 * Shared seeding for the backups cut-set (d) data-layer + scheduler tests
 * (relational-store PLAN Step 5). The four collections are RELATIONAL: the data
 * layer + the scheduler read pglite. So this seeds `databases` / `s3_destination`
 * / `backups` / `backup_runs` directly, the same way `project-graph-test-helpers`
 * seeds the project graph.
 *
 * Pair with `seedIdentity` (every row's `team_id` FK) + `seedServer` (a database's
 * `server_id` RESTRICT FK), and drive the data functions inside
 * `runWithIdentity({ userId, teamId })`.
 *
 * Not named `*.test.ts` so the `node --test` glob skips it (a helper).
 */

const T0 = "2026-01-01T00:00:00.000Z";

/** Truncate every backups-cut-set table (call in `beforeEach` before seeding). */
export const TRUNCATE_BACKUPS = `truncate table
  backup_runs, backups, databases, s3_destination
  restart identity cascade;`;

export interface SeedDatabaseOpts {
  id: string;
  teamId?: string;
  serverId?: string;
  name?: string;
  type?: Database["type"];
  status?: Database["status"];
}

/** Seed one database row (its `connection_string_enc` is a real encrypted value). */
export async function seedDatabase(
  db: TestDb,
  opts: SeedDatabaseOpts,
): Promise<string> {
  const type = opts.type ?? "postgres";
  const name = opts.name ?? opts.id;
  const row: Database = {
    id: opts.id,
    teamId: opts.teamId ?? TEAM_A,
    name,
    type,
    version: "16",
    status: opts.status ?? "running",
    serverId: opts.serverId ?? SERVER_1,
    host: `db-${name}`,
    port: 5432,
    connectionStringEnc: encryptSecret(
      `postgres://app:pw@db-${name}:5432/db-${name}`,
    ),
    exposedPublicly: false,
    exposedPort: null,
    sizeMb: 0,
    createdAt: T0,
  };
  await db.insert(databasesTable).values(databaseToRow(row));
  return row.id;
}

export interface SeedS3Opts {
  id: string;
  teamId?: string;
  name?: string;
  status?: S3Destination["status"];
}

/** Seed one S3 destination (real encrypted access/secret keys). */
export async function seedS3(db: TestDb, opts: SeedS3Opts): Promise<string> {
  const row: S3Destination = {
    id: opts.id,
    teamId: opts.teamId ?? TEAM_A,
    name: opts.name ?? opts.id,
    provider: "aws",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "deplo-backups",
    accessKeyEnc: encryptSecret("AKIA_TEST"),
    secretKeyEnc: encryptSecret("secret_test"),
    status: opts.status ?? "connected",
    createdAt: T0,
  };
  await db.insert(s3Table).values(s3ToRow(row));
  return row.id;
}

export interface SeedBackupOpts {
  id: string;
  teamId?: string;
  destinationId: string;
  databaseId?: string | null;
  projectId?: string | null;
  targetKind?: Backup["targetKind"];
  schedule?: string;
  enabled?: boolean;
  retentionDays?: number;
}

/** Seed one backup SCHEDULE. */
export async function seedBackup(
  db: TestDb,
  opts: SeedBackupOpts,
): Promise<string> {
  const targetKind = opts.targetKind ?? "database";
  const row: Backup = {
    id: opts.id,
    teamId: opts.teamId ?? TEAM_A,
    name: opts.id,
    targetKind,
    databaseId: targetKind === "database" ? (opts.databaseId ?? null) : null,
    projectId: targetKind === "project" ? (opts.projectId ?? null) : null,
    destinationId: opts.destinationId,
    schedule: opts.schedule ?? "0 3 * * *",
    retentionDays: opts.retentionDays ?? 7,
    lastRunAt: null,
    lastStatus: "never",
    enabled: opts.enabled ?? true,
    createdAt: T0,
  };
  await db.insert(backupsTable).values(backupToRow(row));
  return row.id;
}

export interface SeedRunOpts {
  id: string;
  teamId?: string;
  backupId?: string | null;
  destinationId: string;
  databaseId?: string | null;
  projectId?: string | null;
  targetKind?: BackupRun["targetKind"];
  status?: BackupRun["status"];
  objectKey?: string;
  startedAt?: string;
  finishedAt?: string | null;
}

/** Seed one backup RUN (history). `seq` is DB-assigned in insert order. */
export async function seedRun(db: TestDb, opts: SeedRunOpts): Promise<string> {
  const targetKind = opts.targetKind ?? "database";
  const row: BackupRun = {
    id: opts.id,
    teamId: opts.teamId ?? TEAM_A,
    backupId: opts.backupId ?? null,
    targetKind,
    databaseId: targetKind === "database" ? (opts.databaseId ?? null) : null,
    projectId: targetKind === "project" ? (opts.projectId ?? null) : null,
    destinationId: opts.destinationId,
    objectKey: opts.objectKey ?? `deplo/team_a/${targetKind}/t/${opts.id}.gz`,
    sizeBytes: 1024,
    status: opts.status ?? "success",
    error: null,
    startedAt: opts.startedAt ?? T0,
    finishedAt: opts.finishedAt ?? T0,
  };
  await db.insert(backupRunsTable).values(backupRunToRow(row));
  return row.id;
}
