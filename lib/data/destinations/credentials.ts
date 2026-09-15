import "server-only";

import { parseS3Args } from "../../backups/s3-args";
import { decryptSecretOrThrow } from "../../crypto";
import { requireActiveTeamId, requireTeamWide } from "../../membership";
import { loadDestination } from "./listing";
import type { S3Target, StoreTarget } from "../../agent/gen/agent";
import type { BackupDestination, S3Provider } from "../../types/backup";

function pathStyleFor(provider: S3Provider): boolean {
  return provider !== "aws";
}

export interface DestinationWithSecrets {
  destination: BackupDestination;
  accessKey: string;
  secretKey: string;
  ageIdentity: string;
}

export async function getDestinationWithSecretsForTeam(
  teamId: string,
  id: string,
): Promise<DestinationWithSecrets> {
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Destination not found");
  return {
    destination: d,
    accessKey: d.accessKeyEnc
      ? decryptSecretOrThrow(d.accessKeyEnc, "This destination's access key")
      : "",
    secretKey: d.secretKeyEnc
      ? decryptSecretOrThrow(d.secretKeyEnc, "This destination's secret key")
      : "",
    ageIdentity: d.ageIdentityEnc
      ? decryptSecretOrThrow(
          d.ageIdentityEnc,
          "This destination's recovery key",
        )
      : "",
  };
}

export async function getDestinationWithSecrets(
  id: string,
): Promise<DestinationWithSecrets> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("backup destinations");
  return getDestinationWithSecretsForTeam(teamId, id);
}

export function s3TargetFor(
  s: DestinationWithSecrets,
  objectKey: string,
): S3Target {
  const d = s.destination;
  return {
    endpoint: d.endpoint ?? "",
    region: d.region ?? "",
    bucket: d.bucket ?? "",
    accessKey: s.accessKey,
    secretKey: s.secretKey,
    objectKey,
    pathStyle: pathStyleFor(d.provider ?? "other"),
    allowPrivateEndpoint: d.allowPrivateEndpoint,
    extraArgs: parseS3Args(d.s3ExtraArgs),
  };
}

export function storeTargetFor(
  d: BackupDestination,
  objectKey: string,
): StoreTarget {
  return { root: d.path ?? "", objectKey };
}

// The single seam of ADR-0019: the DESTINATION's host for a server store, the workload's for s3.
// Getting it wrong is silent - retention would dial the app's host for an artifact living elsewhere.
export function destinationServerId(
  d: Pick<BackupDestination, "kind" | "serverId">,
  targetServerId: string,
): string {
  return d.kind === "server" && d.serverId ? d.serverId : targetServerId;
}
