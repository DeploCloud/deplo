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

export {
  assertSafeOutboundUrl,
  __setDnsLookupForTest,
  __resetDnsLookupForTest,
} from "../../outbound-url";

export interface CreateDestinationInput {
  name: string;
  kind: DestinationKind;
  provider?: S3Provider | null;
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  accessKey?: string | null;
  secretKey?: string | null;
  allowPrivateEndpoint?: boolean | null;
  s3ExtraArgs?: string | null;
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
  const allowPrivateEndpoint = Boolean(input.allowPrivateEndpoint);
  if (allowPrivateEndpoint) await requireInstanceAdmin();
  if (!allowPrivateEndpoint)
    await assertSafeOutboundUrl((input.endpoint ?? "").trim(), "Endpoint", {
      allowHttp: true,
    });
  else assertHttpUrl((input.endpoint ?? "").trim(), "Endpoint");

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

function assertUsableBucketName(bucket: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$/.test(bucket))
    throw new Error(
      "Bucket names can use letters, digits, dots, dashes and underscores, " +
        "and must start with a letter or digit",
    );
}

function assertUsableRegion(region: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(region))
    throw new Error(
      "Region can use letters, digits, dots, dashes and underscores",
    );
}

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
  const reachable = await listServersForCurrentTeam();
  const server = reachable.find((s) => s.id === serverId);
  if (!server) throw new Error("Not found");
  if (!server.agent?.certFingerprint)
    throw new Error(`${serverLabel(server)} has no agent connected yet`);
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

async function generateAgeKeypair(): Promise<{
  identity: string;
  recipient: string;
}> {
  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

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

  const existing = await getDb()
    .select({ id: destTable.id })
    .from(destTable)
    .where(eq(destTable.teamId, teamId))
    .limit(1);
  if (existing.length > 0) return;

  try {
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
    await release();
  }
}
