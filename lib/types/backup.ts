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

// DestinationKind - where backup artifacts are kept (ADR-0019).
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
  // encrypted at rest
  accessKeyEnc: string | null;
  secretKeyEnc: string | null;
  // Opt out of the SSRF guard on `endpoint`, so a bucket on the operator's own
  // private network is reachable at all.
  allowPrivateEndpoint: boolean;
  // Advanced quirk flags for this one store, as typed. NULL means none. Validated
  // against the allowlist in `lib/backups/s3-args.ts`; the agent applies the ones
  // its version knows.
  s3ExtraArgs: string | null;
  // kind "server": the server holding the artifacts.
  serverId: ID | null;
  // Directory on that server. NULL ⇒ the agent's own managed store.
  path: string | null;
  // The age keypair the artifacts are encrypted to. The RECIPIENT is public and
  // is all the agent gets when writing, so a storage host produces artifacts it
  // cannot itself read.
  ageRecipient: string | null;
  ageIdentityEnc: string | null;
  // When the operator confirmed they had saved the recovery key. Null ⇒ the
  // destination still nudges: a key living only inside the thing that might be
  // lost is not a backup.
  recoveryKeySavedAt: string | null;
  status: DestinationStatus;
  createdAt: string;
  // `lastTestAt` null ⇒ never tested (the `unverified` badge); non-null with an
  // empty `lastTestError` ⇒ the probe passed.
  lastTestAt: string | null;
  lastTestError: string | null;
  // Server whose agent served the probe (null ⇒ never tested, or removed since).
  lastTestServerId: ID | null;
  // Probe duration in ms (null ⇒ never tested).
  lastTestMs: number | null;
  // Server destinations only: headroom and resolved root as of the last check.
  // Information, never a pre-flight gate - a dump's size is unknown until it
  // exists, so ENOSPC on the write is the real guard.
  lastFreeBytes: number | null;
  lastTotalBytes: number | null;
  resolvedPath: string | null;
}

// BackupTargetKind - what a backup schedule / run targets.
export type BackupTargetKind = "database" | "app";

// BackupRunStatus - `canceled` spelled the way `deployments.status` spells it, so
// the two "somebody pressed Stop" states read the same everywhere in the UI.
export type BackupRunStatus = "running" | "success" | "failed" | "canceled";

export interface Backup {
  id: ID;
  teamId: ID;
  name: string;
  // Legacy rows (which could only target a database) are backfilled to
  // `"database"` on hydrate.
  targetKind: BackupTargetKind;
  databaseId: ID | null;
  // Set when `targetKind === "app"`; otherwise null.
  appId: ID | null;
  destinationId: ID;
  schedule: string; // cron
  // IANA zone the cron is read in. "UTC" for every schedule made before it was
  // askable, which is what those always meant.
  timezone: string;
  // A COUNT, not a window: older artifacts are removed after each successful run,
  // and the newest successful one is never removed.
  retentionCount: number;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | "running" | "canceled" | "never";
  enabled: boolean;
  createdAt: string;
}

// BackupRun - one executed backup: a single dump+upload (or restore source).
export interface BackupRun {
  id: ID;
  teamId: ID;
  // The schedule this run came from, or null for an ad-hoc run.
  backupId: ID | null;
  targetKind: BackupTargetKind;
  databaseId: ID | null;
  appId: ID | null;
  destinationId: ID;
  // The target's id as plain text, carried alongside `databaseId`/`appId` because
  // those are `ON DELETE SET NULL`: deleting the app or database blanked the only
  // thing that named what an artifact belonged to.
  targetId: ID;
  // Object key: `deplo/<teamId>/<kind>/<targetId>/<ISO-timestamp>.<ext>`.
  objectKey: string;
  sizeBytes: number;
  // How big the artifact is once decrypted: the exact number of bytes a download
  // delivers, and so its Content-Length.
  decryptedSizeBytes: number | null;
  // Hex sha256 of the artifact as written (ciphertext, before decryption) - what a
  // restore checks before feeding those bytes to anything.
  sha256: string | null;
  // When the orphan sweep first saw this run's target gone.
  orphanedAt: string | null;
  status: BackupRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
