import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret } from "../crypto";
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
  const user = read().users.find((u) => u.id === membership.userId)!;
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
  recordActivity("s3", `Connected S3 destination ${s.name}`, user.name, null);
  return toDTO(s);
}

/** Simulate a connectivity check (HEAD bucket). */
export async function testS3(id: string): Promise<S3DestinationDTO> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  return toDTO(
    mutate((d) => {
      const s = d.s3Destinations.find((x) => x.id === id && x.teamId === teamId);
      if (!s) throw new Error("Not found");
      s.status = "connected";
      return s;
    })
  );
}

export async function deleteS3(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const s = read().s3Destinations.find(
    (x) => x.id === id && x.teamId === membership.teamId,
  );
  if (!s) throw new Error("Not found");
  mutate((d) => {
    d.s3Destinations = d.s3Destinations.filter((x) => x.id !== id);
    d.backups = d.backups.filter((b) => b.destinationId !== id);
  });
  recordActivity("s3", `Removed S3 destination ${s.name}`, user.name, null);
}
