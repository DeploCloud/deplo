import "server-only";

import { read, mutate } from "../store";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import {
  connectBackupAgent,
  mapBackupUnsupported,
  AgentUnreachableError,
} from "../infra/agent-client";
import type { S3Target } from "../agent/gen/agent";
import type { S3Destination, S3Provider } from "../types";

export interface S3DestinationDTO
  extends Omit<S3Destination, "accessKeyEnc" | "secretKeyEnc"> {
  accessKeyMasked: string;
}

function toDTO(s: S3Destination): S3DestinationDTO {
  const { accessKeyEnc, secretKeyEnc, ...rest } = s;
  void secretKeyEnc;
  return { ...rest, accessKeyMasked: "••••••••" };
}

export const S3_PROVIDERS: { id: S3Provider; name: string; endpointHint: string }[] = [
  { id: "aws", name: "Amazon S3", endpointHint: "https://s3.<region>.amazonaws.com" },
  { id: "cloudflare-r2", name: "Cloudflare R2", endpointHint: "https://<account>.r2.cloudflarestorage.com" },
  { id: "backblaze-b2", name: "Backblaze B2", endpointHint: "https://s3.<region>.backblazeb2.com" },
  { id: "digitalocean", name: "DigitalOcean Spaces", endpointHint: "https://<region>.digitaloceanspaces.com" },
  { id: "wasabi", name: "Wasabi", endpointHint: "https://s3.<region>.wasabisys.com" },
  { id: "minio", name: "MinIO (self-hosted)", endpointHint: "https://minio.example.com" },
  { id: "other", name: "Other S3-compatible", endpointHint: "https://..." },
];

/**
 * Whether to address a provider's bucket PATH-style (bucket in the URL path) vs
 * VIRTUAL-HOST style (bucket as a subdomain). AWS S3 is virtual-host; the
 * S3-compatible stores (R2, B2, Spaces, Wasabi, self-hosted MinIO, "other")
 * generally need or tolerate path-style, so we default everything non-AWS to
 * path-style. The agent's minio-go client honours this flag.
 */
function pathStyleFor(provider: S3Provider): boolean {
  return provider !== "aws";
}

/**
 * A destination with its creds DECRYPTED, for the backup executor only
 * (server-only). NEVER returned to a client — `S3DestinationDTO` is the
 * client-facing masked shape. The decrypted access/secret keys ride the mTLS
 * channel to the owning agent, which holds the S3 client (minio-go); the bytes
 * never round-trip through the control plane.
 */
export interface S3WithSecrets {
  destination: S3Destination;
  accessKey: string;
  secretKey: string;
}

/**
 * Load a destination with its creds decrypted for a SPECIFIC team — the
 * session-free core. Throws when the id is unknown / not in `teamId` so a backup
 * can't target a foreign bucket. The scheduler (Step 6) runs with NO request
 * context, so it must call this with the schedule's own `teamId` rather than the
 * cookie-derived active team; the interactive {@link getS3WithSecrets} wraps it.
 */
export function getS3WithSecretsForTeam(
  teamId: string,
  id: string,
): S3WithSecrets {
  const s = read().s3Destinations.find((x) => x.id === id && x.teamId === teamId);
  if (!s) throw new Error("Destination not found");
  return {
    destination: s,
    accessKey: decryptSecret(s.accessKeyEnc),
    secretKey: decryptSecret(s.secretKeyEnc),
  };
}

/**
 * Load the ACTIVE team's S3 destination with its creds decrypted, for the
 * interactive executor (manual "Run now" / restore). Scoped to the active team
 * via the session (mirrors every other team-scoped read). The unattended
 * scheduler uses {@link getS3WithSecretsForTeam} instead (no session).
 */
export async function getS3WithSecrets(id: string): Promise<S3WithSecrets> {
  const teamId = await requireActiveTeamId();
  return getS3WithSecretsForTeam(teamId, id);
}

/**
 * Build the wire {@link S3Target} for an agent Backup/Restore/S3* call from a
 * decrypted destination + the exact object key (or prefix). The ONE place the
 * destination → S3Target mapping (incl. the provider's path-style decision)
 * lives, so the executor, the connectivity check, and the retention pruner can't
 * drift on it.
 */
export function s3TargetFor(s: S3WithSecrets, objectKey: string): S3Target {
  const d = s.destination;
  return {
    endpoint: d.endpoint,
    region: d.region,
    bucket: d.bucket,
    accessKey: s.accessKey,
    secretKey: s.secretKey,
    objectKey,
    pathStyle: pathStyleFor(d.provider),
  };
}

export async function listS3(): Promise<S3DestinationDTO[]> {
  const teamId = await requireActiveTeamId();
  return read()
    .s3Destinations.filter((s) => s.teamId === teamId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(toDTO);
}

export async function createS3(input: {
  name: string;
  provider: S3Provider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}): Promise<S3DestinationDTO> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");
  if (!input.bucket.trim()) throw new Error("Bucket is required");
  if (!input.accessKey || !input.secretKey)
    throw new Error("Access key and secret are required");

  const s: S3Destination = {
    id: newId("s3"),
    teamId: membership.teamId,
    name: input.name.trim(),
    provider: input.provider,
    endpoint: input.endpoint.trim(),
    region: input.region.trim() || "auto",
    bucket: input.bucket.trim(),
    accessKeyEnc: encryptSecret(input.accessKey),
    secretKeyEnc: encryptSecret(input.secretKey),
    status: "unverified",
    createdAt: nowIso(),
  };
  mutate((d) => d.s3Destinations.push(s));
  await recordActivity("s3", `Connected S3 destination ${s.name}`, user.name, null);
  return toDTO(s);
}

/**
 * Verify S3 connectivity for real: dial a reachable agent advertising the
 * `"backup"` capability and have IT probe the bucket (HEAD + a write probe) with
 * the decrypted creds over mTLS — the agent owns the S3 client (minio-go). The
 * destination's `status` is persisted from the live result (`connected` on
 * success, `error` otherwise) so the badge reflects reality, never a fake
 * success.
 *
 * Any provisioned, backup-capable agent can serve the probe (it needs no Docker,
 * just network + creds), so we try provisioned servers until one answers. If NO
 * server has a backup-capable agent yet, we surface the agent-update guidance
 * ({@link AgentBackupUnsupportedError}) rather than flipping to `connected`.
 */
export async function testS3(id: string): Promise<S3DestinationDTO> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  const cur = read().s3Destinations.find((x) => x.id === id && x.teamId === teamId);
  if (!cur) throw new Error("Not found");

  const creds = await getS3WithSecrets(id);
  // `S3Check` ignores the object key (it's a bucket probe), but the wire type
  // requires one — a sentinel that documents intent.
  const target = s3TargetFor(creds, "deplo/.s3check");

  const { ok } = await checkOnAnyBackupAgent(target);

  return toDTO(
    mutate((d) => {
      const s = d.s3Destinations.find((x) => x.id === id && x.teamId === teamId);
      if (!s) throw new Error("Not found");
      s.status = ok ? "connected" : "error";
      return s;
    }),
  );
}

/**
 * Run `S3Check` on the first reachable, backup-capable agent. Tries provisioned
 * servers in turn: an unreachable one (or one too old to back up) is skipped to
 * the next. Returns the agent's `{ ok, error }` verdict. Throws
 * {@link AgentBackupUnsupportedError} only when EVERY server lacks the capability
 * (so the UI says "update the agent"); throws {@link AgentUnreachableError} when
 * no server is reachable at all.
 */
async function checkOnAnyBackupAgent(
  target: S3Target,
): Promise<{ ok: boolean; error: string }> {
  const servers = read().servers.filter((s) => s.agent?.certFingerprint);
  if (servers.length === 0) {
    throw new AgentUnreachableError(
      "No provisioned server is available to verify the bucket.",
    );
  }
  let lastUnsupported: Error | null = null;
  let lastUnreachable: Error | null = null;
  for (const server of servers) {
    let conn;
    try {
      conn = await connectBackupAgent(server.id);
    } catch (e) {
      const mapped = mapBackupUnsupported(e);
      if (mapped instanceof AgentUnreachableError) lastUnreachable = mapped;
      else lastUnsupported = mapped;
      continue; // try the next server
    }
    try {
      return await conn.s3Check(target);
    } catch (e) {
      // The RPC itself failed: an old agent (UNIMPLEMENTED) → try the next; a
      // transport drop → try the next; otherwise it's a real probe failure.
      const mapped = mapBackupUnsupported(e);
      if (mapped instanceof AgentUnreachableError) lastUnreachable = mapped;
      else if (mapped.name === "AgentBackupUnsupportedError") lastUnsupported = mapped;
      else return { ok: false, error: mapped.message };
    } finally {
      conn.close();
    }
  }
  // Nothing answered: prefer the actionable "update the agent" when at least one
  // server was reachable-but-too-old; else report unreachable.
  throw lastUnsupported ?? lastUnreachable ?? new AgentUnreachableError(
    "No backup-capable agent could verify the bucket.",
  );
}

export async function deleteS3(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const s = read().s3Destinations.find(
    (x) => x.id === id && x.teamId === membership.teamId,
  );
  if (!s) throw new Error("Not found");
  mutate((d) => {
    d.s3Destinations = d.s3Destinations.filter((x) => x.id !== id);
    d.backups = d.backups.filter((b) => b.destinationId !== id);
  });
  await recordActivity("s3", `Removed S3 destination ${s.name}`, user.name, null);
}
