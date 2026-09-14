import "server-only";

import { parseS3Args } from "../../backups/s3-args";
import { decryptSecretOrThrow } from "../../crypto";
import { requireActiveTeamId, requireTeamWide } from "../../membership";
import { loadDestination } from "./listing";
import type { S3Target, StoreTarget } from "../../agent/gen/agent";
import type { BackupDestination, S3Provider } from "../../types/backup";

// Whether to address a provider's bucket PATH-style rather than VIRTUAL-HOST style.
function pathStyleFor(provider: S3Provider): boolean {
  return provider !== "aws";
}

// DestinationWithSecrets is a destination DECRYPTED, for the executor only - never a client.
export interface DestinationWithSecrets {
  destination: BackupDestination;
  accessKey: string;
  secretKey: string;
  // server only: the private half. Never send this on a BackupRequest.
  ageIdentity: string;
}

// getDestinationWithSecretsForTeam is the session-free core: throws when the id is not in `teamId`.
export async function getDestinationWithSecretsForTeam(
  teamId: string,
  id: string,
): Promise<DestinationWithSecrets> {
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Destination not found");
  // Strict, not best-effort.
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

// getDestinationWithSecrets loads the ACTIVE team's destination, decrypted, for the interactive executor.
export async function getDestinationWithSecrets(
  id: string,
): Promise<DestinationWithSecrets> {
  const teamId = await requireActiveTeamId();
  // A destination belongs to the team, not to a Project, so a project-scoped API
  // token has no business READING one.
  await requireTeamWide("backup destinations");
  return getDestinationWithSecretsForTeam(teamId, id);
}

// s3TargetFor builds the wire S3Target for an agent call, for one object key or prefix.
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
    // Off for everything created from the ordinary form; on only where an
    // instance admin said the bucket lives on their own network.
    allowPrivateEndpoint: d.allowPrivateEndpoint,
    // The agent applies the flags its version knows and logs the rest - see the
    // soft gate in `connectBackupAgent`, which warns rather than refusing.
    extraArgs: parseS3Args(d.s3ExtraArgs),
  };
}

// storeTargetFor builds the wire StoreTarget for a `server` destination + an object key.
export function storeTargetFor(
  d: BackupDestination,
  objectKey: string,
): StoreTarget {
  // Empty root means "the agent's own managed store" - the default, and the only
  // shape a non-admin can produce. A custom path travels verbatim and the agent
  // re-validates it against its sentinel rule.
  return { root: d.path ?? "", objectKey };
}

// destinationServerId names WHICH SERVER's agent handles this destination - the single
// seam of ADR-0019: the DESTINATION's host for `server`, the workload's for `s3`.
// Getting it wrong is silent: retention would dial the app's host for an artifact elsewhere.
export function destinationServerId(
  d: Pick<BackupDestination, "kind" | "serverId">,
  targetServerId: string,
): string {
  return d.kind === "server" && d.serverId ? d.serverId : targetServerId;
}
