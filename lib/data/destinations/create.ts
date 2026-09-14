import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { listServersForCurrentTeam } from "../servers/roster";
import { getDb } from "../../db/client";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { destinationToRow } from "../backup-rows";
import { assertSafeOutboundUrl } from "../../outbound-url";
import { validateS3Args } from "../../backups/s3-args";
import { getCurrentUser } from "../../auth/current-user";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import { serverLabel } from "../../utils";
import { newId, nowIso } from "../../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
} from "../../membership";
import { recordActivity } from "../activity";
import { encryptSecret } from "../../crypto";
import { withServerName, type DestinationDTO } from "./dto";
import type {
  BackupDestination,
  DestinationKind,
  DestinationStatus,
  S3Provider,
} from "../../types/backup";

// The guard is a leaf in `lib/outbound-url.ts` so the alert channels can import it
// without closing a cycle back through this module's activity logging.
export {
  assertSafeOutboundUrl,
  __setDnsLookupForTest,
  __resetDnsLookupForTest,
} from "../../outbound-url";

export interface CreateDestinationInput {
  name: string;
  kind: DestinationKind;
  /* s3 */
  provider?: S3Provider | null;
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  accessKey?: string | null;
  secretKey?: string | null;
  // Instance-admin only: dial an endpoint on a private address.
  allowPrivateEndpoint?: boolean | null;
  // Advanced quirk flags, validated against the allowlist in `lib/backups/s3-args.ts`.
  s3ExtraArgs?: string | null;
  /* server */
  serverId?: string | null;
  path?: string | null;
}

export async function createDestination(
  input: CreateDestinationInput,
): Promise<DestinationDTO> {
  const { membership } = await requireCapability("manage_backup_destinations");
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");

  const base = {
    id: newId("dst"),
    teamId: membership.teamId,
    name: input.name.trim(),
    status: "unverified" as DestinationStatus,
    createdAt: nowIso(),
    lastTestAt: null,
    lastTestError: null,
    lastTestServerId: null,
    lastTestMs: null,
    lastFreeBytes: null,
    lastTotalBytes: null,
    resolvedPath: null,
    recoveryKeySavedAt: null,
  };

  let d: BackupDestination;
  if (input.kind === "server") {
    d = { ...base, ...(await serverDestinationFields(input)) };
  } else {
    d = { ...base, ...(await s3DestinationFields(input)) };
  }

  await getDb().insert(destTable).values(destinationToRow(d));
  await recordActivity(
    "s3",
    `Added backup destination ${d.name}`,
    user.name,
    null,
    d.teamId,
  );
  return withServerName(d);
}

async function s3DestinationFields(input: CreateDestinationInput) {
  const bucket = (input.bucket ?? "").trim();
  if (!bucket) throw new Error("Bucket is required");
  assertUsableBucketName(bucket);
  if (!input.accessKey || !input.secretKey)
    throw new Error("Access key and secret are required");
  const region = (input.region ?? "").trim() || "auto";
  assertUsableRegion(region);
  // A private endpoint is an instance-level decision: the agent dials this address
  // as root, so 169.254.169.254 must never be reachable from a form anyone can fill in.
  const allowPrivateEndpoint = Boolean(input.allowPrivateEndpoint);
  if (allowPrivateEndpoint) await requireInstanceAdmin();
  // Never let the endpoint aim inside the network unless that was the explicit,
  // admin-only choice. http stays allowed for a self-hosted MinIO fronted without TLS.
  if (!allowPrivateEndpoint)
    await assertSafeOutboundUrl((input.endpoint ?? "").trim(), "Endpoint", {
      allowHttp: true,
    });
  else assertHttpUrl((input.endpoint ?? "").trim(), "Endpoint");

  // A BUCKET artifact is encrypted too: a project archive carries the app's entire
  // decrypted env, because the restore has to write the real `.env` back.
  const rawArgs = (input.s3ExtraArgs ?? "").trim();
  const argsError = validateS3Args(rawArgs);
  if (argsError) throw new Error(argsError);
  const s3ExtraArgs = rawArgs || null;

  const { identity, recipient } = await generateAgeKeypair();
  return {
    kind: "s3" as const,
    provider: input.provider ?? "other",
    endpoint: (input.endpoint ?? "").trim(),
    region,
    bucket,
    accessKeyEnc: encryptSecret(input.accessKey),
    secretKeyEnc: encryptSecret(input.secretKey),
    allowPrivateEndpoint,
    s3ExtraArgs,
    serverId: null,
    path: null,
    ageRecipient: recipient,
    ageIdentityEnc: encryptSecret(identity),
  };
}

// A bucket name Deplo is willing to store, print and hand to an operator.
function assertUsableBucketName(bucket: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$/.test(bucket))
    throw new Error(
      "Bucket names can use letters, digits, dots, dashes and underscores, " +
        "and must start with a letter or digit",
    );
}

// Same, for the region - it rides the same command line.
function assertUsableRegion(region: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(region))
    throw new Error(
      "Region can use letters, digits, dots, dashes and underscores",
    );
}

// The shape check that survives when the SSRF guard is deliberately off: the agent
// must still get something it can dial.
function assertHttpUrl(raw: string, label: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`${label} must be an http(s) URL`);
  if (!url.hostname) throw new Error(`${label} must include a host`);
}

async function serverDestinationFields(input: CreateDestinationInput) {
  const serverId = input.serverId?.trim();
  if (!serverId) throw new Error("Pick a server to store the backups on");
  // Servers are the resource Deplo does not team-scope, so the host must be one the
  // ACTIVE TEAM can already reach.
  const reachable = await listServersForCurrentTeam();
  const server = reachable.find((s) => s.id === serverId);
  if (!server) throw new Error("Not found");
  if (!server.agent?.certFingerprint)
    throw new Error(`${serverLabel(server)} has no agent connected yet`);
  // A migration source is the other platform's machine, and its agent is removed the
  // day the migration ends.
  if (server.importOnly)
    throw new Error(
      `${serverLabel(server)} is a migration source - Deplo is only borrowing it ` +
        `to import from. Pick a server in your fleet.`,
    );

  const path = input.path?.trim() || null;
  if (path) {
    await requireInstanceAdmin();
    if (!path.startsWith("/"))
      throw new Error(
        "The backup folder must be an absolute path, like /mnt/backups",
      );
  }

  const { identity, recipient } = await generateAgeKeypair();
  return {
    kind: "server" as const,
    provider: null,
    endpoint: null,
    region: null,
    bucket: null,
    accessKeyEnc: null,
    secretKeyEnc: null,
    allowPrivateEndpoint: false,
    s3ExtraArgs: null,
    serverId,
    path,
    ageRecipient: recipient,
    ageIdentityEnc: encryptSecret(identity),
  };
}

// Mint the age X25519 keypair a destination encrypts to.
async function generateAgeKeypair(): Promise<{
  identity: string;
  recipient: string;
}> {
  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

// ensureDefaultDestination gives every team a destination that works, on a disk the fleet already has.
export async function ensureDefaultDestination(): Promise<void> {
  const teamId = await requireActiveTeamId();
  const claimed = await getDb()
    .update(teamsTable)
    .set({ backupDefaultSeededAt: nowIso() })
    .where(
      and(eq(teamsTable.id, teamId), isNull(teamsTable.backupDefaultSeededAt)),
    )
    .returning({ id: teamsTable.id });
  if (claimed.length === 0) return;
  const release = () =>
    getDb()
      .update(teamsTable)
      .set({ backupDefaultSeededAt: null })
      .where(eq(teamsTable.id, teamId));

  // An instance that already had destinations before this ran keeps the claim: it has
  // what the seed exists to provide, and must not get another one the day it removes
  // the last of them.
  const existing = await getDb()
    .select({ id: destTable.id })
    .from(destTable)
    .where(eq(destTable.teamId, teamId))
    .limit(1);
  if (existing.length > 0) return;

  try {
    // The Deplo host first, then any other provisioned server: a default silently
    // living on some other box is a surprise the day that box goes away, and a
    // migration source is neither ours to fill nor ours to keep.
    const provisioned = (await listServersForCurrentTeam()).filter(
      (s) => s.agent?.certFingerprint && !s.importOnly,
    );
    const self = deploHostSelfAddresses();
    const server =
      provisioned.find((s) => isDeploHostServer(s, self)) ?? provisioned[0];
    if (!server) {
      await release();
      return;
    }
    const name = isDeploHostServer(server, self)
      ? "This server"
      : serverLabel(server);

    const { identity, recipient } = await generateAgeKeypair();
    const d: BackupDestination = {
      id: newId("dst"),
      teamId,
      name,
      kind: "server",
      provider: null,
      s3ExtraArgs: null,
      endpoint: null,
      region: null,
      bucket: null,
      accessKeyEnc: null,
      secretKeyEnc: null,
      allowPrivateEndpoint: false,
      serverId: server.id,
      path: null,
      ageRecipient: recipient,
      ageIdentityEnc: encryptSecret(identity),
      recoveryKeySavedAt: null,
      status: "unverified",
      createdAt: nowIso(),
      lastTestAt: null,
      lastTestError: null,
      lastTestServerId: null,
      lastTestMs: null,
      lastFreeBytes: null,
      lastTotalBytes: null,
      resolvedPath: null,
    };
    await getDb().insert(destTable).values(destinationToRow(d));
  } catch {
    // Nothing was created: hand the claim back so a later render can try again. This is
    // a convenience, never a precondition.
    await release();
  }
}
