import type { ID } from "./identity";

export type S3Provider =
  | "aws"
  | "cloudflare-r2"
  | "backblaze-b2"
  | "minio"
  | "digitalocean"
  | "wasabi"
  | "other";

export type DestinationStatus = "connected" | "error" | "unverified";

export type DestinationKind = "s3" | "server";

export interface BackupDestination {
  id: ID;
  teamId: ID;
  name: string;
  kind: DestinationKind;
  provider: S3Provider | null;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  accessKeyEnc: string | null;
  secretKeyEnc: string | null;
  allowPrivateEndpoint: boolean;
  s3ExtraArgs: string | null;
  serverId: ID | null;
  path: string | null;
  ageRecipient: string | null;
  ageIdentityEnc: string | null;
  recoveryKeySavedAt: string | null;
  status: DestinationStatus;
  createdAt: string;
  lastTestAt: string | null;
  lastTestError: string | null;
  lastTestServerId: ID | null;
  lastTestMs: number | null;
  lastFreeBytes: number | null;
  lastTotalBytes: number | null;
  resolvedPath: string | null;
}

export type BackupTargetKind = "database" | "app";

export type BackupRunStatus = "running" | "success" | "failed" | "canceled";

export interface Backup {
  id: ID;
  teamId: ID;
  name: string;
  targetKind: BackupTargetKind;
  databaseId: ID | null;
  appId: ID | null;
  destinationId: ID;
  schedule: string;
  timezone: string;
  retentionCount: number;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | "running" | "canceled" | "never";
  enabled: boolean;
  createdAt: string;
}

export interface BackupRun {
  id: ID;
  teamId: ID;
  backupId: ID | null;
  targetKind: BackupTargetKind;
  databaseId: ID | null;
  appId: ID | null;
  destinationId: ID;
  targetId: ID;
  objectKey: string;
  sizeBytes: number;
  decryptedSizeBytes: number | null;
  sha256: string | null;
  orphanedAt: string | null;
  status: BackupRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
