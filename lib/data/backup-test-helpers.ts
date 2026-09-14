import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  backupDestination as destTable,
} from "../db/schema/control-plane/backups";
import {
  databaseMounts as databaseMountsTable,
  databases as databasesTable,
} from "../db/schema/control-plane/databases";
import {
  backupToRow,
  backupRunToRow,
  databaseToRow,
  destinationToRow,
} from "./backup-rows";
import { encryptSecret } from "../crypto";
import type { TestDb } from "../db/test-harness";
import type { Backup, BackupRun, BackupDestination } from "../types/backup";
import type { Database } from "../types/database";
import { TEAM_A } from "./identity-test-helpers";
import { SERVER_1 } from "./app-graph-test-helpers";

const T0 = "2026-01-01T00:00:00.000Z";

// TRUNCATE_BACKUPS clears every backups-cut-set table; call it in `beforeEach` before seeding.
export const TRUNCATE_BACKUPS = `truncate table
  pending_teardowns, backup_runs, backups, databases, backup_destination
  restart identity cascade;`;

// settleProvisioning drains every floated `provisionDatabase`; call it before truncating or closing.
export async function settleProvisioning(db: TestDb): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const rows = await db
      .select({ status: databasesTable.status })
      .from(databasesTable);
    if (!rows.some((r) => r.status === "provisioning")) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  // The status flip is not the last thing provisioning does (the readiness alert is
  // dispatched after it, and floats too), so give the tail a turn to land.
  await new Promise((r) => setTimeout(r, 100));
}

export interface SeedDatabaseOpts {
  id: string;
  teamId?: string;
  serverId?: string;
  name?: string;
  type?: Database["type"];
  username?: string;
  dbName?: string;
  status?: Database["status"];
  exposedPublicly?: boolean;
  exposedPort?: number | null;
  mounts?: Database["mounts"];
}

// seedDatabase seeds one database row; its `connection_string_enc` is a real encrypted value.
export async function seedDatabase(
  db: TestDb,
  opts: SeedDatabaseOpts,
): Promise<string> {
  const type = opts.type ?? "postgres";
  const name = opts.name ?? opts.id;
  const row: Database = {
    environmentId: null,
    id: opts.id,
    teamId: opts.teamId ?? TEAM_A,
    name,
    dataCopyError: "",
    migrationRunId: null,
    logo: null,
    type,
    version: "16",
    // Mirror what createDatabase / the 0014 backfill produce: the engine login `app`
    // and the logical DB == the service name (`db-<name>`).
    username: opts.username ?? (type === "redis" ? "default" : "app"),
    dbName: opts.dbName ?? `db-${name}`,
    status: opts.status ?? "running",
    serverId: opts.serverId ?? SERVER_1,
    host: `db-${name}`,
    port: 5432,
    connectionStringEnc: encryptSecret(
      `postgres://app:pw@db-${name}:5432/db-${name}`,
    ),
    exposedPublicly: opts.exposedPublicly ?? false,
    exposedPort: opts.exposedPort ?? null,
    resources: null,
    customImage: null,
    customCommand: null,
    cronEnabled: false,
    mounts: opts.mounts ?? [],
    sizeMb: 0,
    createdAt: T0,
  };
  await db.insert(databasesTable).values(databaseToRow(row));
  if (row.mounts.length > 0) {
    await db.insert(databaseMountsTable).values(
      row.mounts.map((m, position) => ({
        databaseId: row.id,
        position,
        ...m,
      })),
    );
  }
  return row.id;
}

export interface SeedDestinationOpts {
  id: string;
  teamId?: string;
  legacyPlaintext?: boolean;
  name?: string;
  status?: BackupDestination["status"];
  kind?: BackupDestination["kind"];
  serverId?: string;
  path?: string | null;
  lastTest?: {
    at: string;
    error?: string | null;
    serverId?: string | null;
    ms?: number | null;
  };
}

// seedDestination seeds one backup destination.
export async function seedDestination(
  db: TestDb,
  opts: SeedDestinationOpts,
): Promise<string> {
  const kind = opts.kind ?? "s3";
  const common = {
    id: opts.id,
    teamId: opts.teamId ?? TEAM_A,
    name: opts.name ?? opts.id,
    status: opts.status ?? ("connected" as const),
    createdAt: T0,
    recoveryKeySavedAt: null,
    lastTestAt: opts.lastTest?.at ?? null,
    lastTestError: opts.lastTest?.error ?? null,
    lastTestServerId: opts.lastTest?.serverId ?? null,
    lastTestMs: opts.lastTest?.ms ?? null,
    lastFreeBytes: null,
    lastTotalBytes: null,
    resolvedPath: null,
    allowPrivateEndpoint: false,
    s3ExtraArgs: null,
  };
  const row: BackupDestination =
    kind === "server"
      ? {
          ...common,
          kind: "server",
          provider: null,
          endpoint: null,
          region: null,
          bucket: null,
          accessKeyEnc: null,
          secretKeyEnc: null,
          serverId: opts.serverId ?? SERVER_1,
          path: opts.path ?? null,
          ageRecipient: AGE_RECIPIENT,
          ageIdentityEnc: encryptSecret(AGE_IDENTITY),
        }
      : {
          ...common,
          kind: "s3",
          provider: "aws",
          endpoint: "https://s3.us-east-1.amazonaws.com",
          region: "us-east-1",
          bucket: "deplo-backups",
          accessKeyEnc: encryptSecret("AKIA_TEST"),
          secretKeyEnc: encryptSecret("secret_test"),
          serverId: null,
          path: null,
          ...(opts.legacyPlaintext
            ? { ageRecipient: null, ageIdentityEnc: null }
            : {
                ageRecipient: AGE_RECIPIENT,
                ageIdentityEnc: encryptSecret(AGE_IDENTITY),
              }),
        };
  await db.insert(destTable).values(destinationToRow(row));
  return row.id;
}

// seedS3 is a back-compat alias for tests that only want "a destination that exists".
export const seedS3 = seedDestination;

const AGE_RECIPIENT =
  "age1ajphv95pnsjagt46mqghtvszrkrv2xay73pjvvedum2xhj4624ts2ujm3l";
const AGE_IDENTITY =
  "AGE-SECRET-KEY-1QVJ9ZZZ8QKZ7EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXA";

export interface SeedBackupOpts {
  id: string;
  teamId?: string;
  destinationId: string;
  databaseId?: string | null;
  appId?: string | null;
  targetKind?: Backup["targetKind"];
  schedule?: string;
  timezone?: string;
  enabled?: boolean;
  retentionCount?: number;
}

// seedBackup seeds one backup schedule.
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
    appId: targetKind === "app" ? (opts.appId ?? null) : null,
    destinationId: opts.destinationId,
    schedule: opts.schedule ?? "0 3 * * *",
    timezone: opts.timezone ?? "UTC",
    retentionCount: opts.retentionCount ?? 7,
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
  appId?: string | null;
  targetKind?: BackupRun["targetKind"];
  targetId?: string;
  sizeBytes?: number;
  sha256?: string | null;
  decryptedSizeBytes?: number | null;
  orphanedAt?: string | null;
  status?: BackupRun["status"];
  objectKey?: string;
  startedAt?: string;
  finishedAt?: string | null;
}

// seedRun seeds one backup run; `seq` is DB-assigned in insert order.
export async function seedRun(db: TestDb, opts: SeedRunOpts): Promise<string> {
  const targetKind = opts.targetKind ?? "database";
  const row: BackupRun = {
    id: opts.id,
    teamId: opts.teamId ?? TEAM_A,
    backupId: opts.backupId ?? null,
    targetKind,
    databaseId: targetKind === "database" ? (opts.databaseId ?? null) : null,
    appId: targetKind === "app" ? (opts.appId ?? null) : null,
    destinationId: opts.destinationId,
    // Survives the ON DELETE SET NULL on the two columns above, which is what lets
    // retention and the orphan sweep still find a deleted target's files.
    targetId:
      (targetKind === "database" ? opts.databaseId : opts.appId) ??
      opts.targetId ??
      "t",
    objectKey: opts.objectKey ?? `deplo/team_a/${targetKind}/t/${opts.id}.gz`,
    sizeBytes: opts.sizeBytes ?? 1024,
    decryptedSizeBytes: opts.decryptedSizeBytes ?? null,
    sha256: opts.sha256 ?? null,
    orphanedAt: opts.orphanedAt ?? null,
    status: opts.status ?? "success",
    error: null,
    startedAt: opts.startedAt ?? T0,
    finishedAt: opts.finishedAt ?? T0,
  };
  await db.insert(backupRunsTable).values(backupRunToRow(row));
  return row.id;
}
