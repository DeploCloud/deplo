import "server-only";

import { status as GrpcStatus, type ServiceError } from "@grpc/grpc-js";

// AgentUnreachableError - the agent could not be reached (caller falls back).
export class AgentUnreachableError extends Error {
  constructor(
    message: string,
    /** The gRPC status code we normalised, when the failure came from an RPC. */
    readonly code?: number,
    /** A TRUST failure rather than a dead host: the peer presented a cert that is
     *  not the pinned one, or it rejected OUR client cert (UNAUTHENTICATED). */
    readonly trust?: boolean,
  ) {
    super(message);
  }
}

// AgentNetworkUnsupportedError - the agent cannot put a stack on the network its
// placement owns (ADR-0028); its own class so a deploy can name the server.
export class AgentNetworkUnsupportedError extends Error {}

// AgentUpdateUnsupportedError - the agent has no in-place self-update RPC.
export class AgentUpdateUnsupportedError extends Error {}

// AgentUninstallUnsupportedError - the agent is too old to remove itself; the
// operator's next step is the host-side command.
export class AgentUninstallUnsupportedError extends Error {}

// AgentBackupUnsupportedError - the agent does not implement the backup RPCs.
export class AgentBackupUnsupportedError extends Error {}

// AgentBackupStoreUnsupportedError - the agent can back up to S3 but cannot hold
// artifacts on its own disk.
export class AgentBackupStoreUnsupportedError extends Error {}

// AgentMetricsStreamUnsupportedError - the agent predates the telemetry stream.
export class AgentMetricsStreamUnsupportedError extends Error {}

// AgentCheckPortUnsupportedError - the agent has no CheckPort RPC.
export class AgentCheckPortUnsupportedError extends Error {}

// AgentVolumeCopyUnsupportedError - the agent has none of the cross-host data-copy
// RPCs a server move uses (volume-copy and/or files-copy).
export class AgentVolumeCopyUnsupportedError extends Error {}

// AgentCleanupUnsupportedError - the agent has no DockerCleanup RPC.
export class AgentCleanupUnsupportedError extends Error {}

// AgentCronUnsupportedError - the agent has no cron RPCs (ADR-0018).
export class AgentCronUnsupportedError extends Error {}

// AgentHostOpsUnsupportedError - the agent is too old for the host-ops RPCs.
export class AgentHostOpsUnsupportedError extends Error {}

// AgentControlPlaneUpdateUnsupportedError - the agent cannot update the panel: the
// UI falls back on the command.
export class AgentControlPlaneUpdateUnsupportedError extends Error {}

/** The single message an out-of-date agent produces, wherever the gap is caught -
 *  the Hello pre-flight or the RPC's own UNIMPLEMENTED. One string so the two
 *  paths can never drift into two different stories. */
export const CLEANUP_UNSUPPORTED_MESSAGE =
  "The agent on this server is too old to clean up Docker disk. " +
  "Update the agent on this server, then try again.";

export const CRON_UNSUPPORTED_MESSAGE =
  "This server's agent is too old to run cron jobs. Update the agent on this server, then try again.";

export const HOSTOPS_UNSUPPORTED_MESSAGE =
  "The agent on this server is too old for host management. " +
  "Update the agent on this server, then try again.";

export const CONTROL_PLANE_UPDATE_UNSUPPORTED_MESSAGE =
  "The agent on this server is too old to update Deplo itself. " +
  "Update the agent on this server first, or run the command below on the machine.";

// Codes that mean "the agent is down / not answering" rather than "the agent
// answered with an application error".
const TRANSPORT_DOWN_CODES = new Set<number>([
  GrpcStatus.UNAVAILABLE, // connection refused / TLS / keepalive / agent gone
  GrpcStatus.DEADLINE_EXCEEDED, // dialed but never answered within the deadline
  GrpcStatus.UNAUTHENTICATED, // mTLS handshake failed (revoked / wrong cert)
]);

// toAgentError normalises a transport-down gRPC error into AgentUnreachableError;
// an application error the agent deliberately returned passes through unchanged.
export function toAgentError(err: unknown): Error {
  if (err instanceof AgentUnreachableError) return err;
  const code = (err as Partial<ServiceError> | null)?.code;
  if (typeof code === "number" && TRANSPORT_DOWN_CODES.has(code)) {
    const msg = err instanceof Error ? err.message : String(err);
    // Carry the code so the health prober can separate "no answer within the
    // deadline" from "connection refused". Every other caller ignores it.
    return new AgentUnreachableError(msg, code);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Why a log stream died, in the only vocabulary the browser is allowed to see. */
export type LogsFailure = "unreachable" | "not-found" | "denied" | "failed";

// logsFailureReason curates a FollowLogs stream failure into a client-safe reason.
export function logsFailureReason(err: unknown): LogsFailure {
  if (toAgentError(err) instanceof AgentUnreachableError) return "unreachable";
  const code = (err as Partial<ServiceError> | null)?.code;
  if (code === GrpcStatus.NOT_FOUND) return "not-found";
  if (code === GrpcStatus.PERMISSION_DENIED) return "denied";
  return "failed";
}

// mapCheckPortUnsupported maps a gRPC UNIMPLEMENTED to
// AgentCheckPortUnsupportedError; every other error passes through unchanged.
export function mapCheckPortUnsupported(e: unknown): Error {
  if (e instanceof AgentCheckPortUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentCheckPortUnsupportedError(
      "This server's agent is too old to check port availability. Update the agent on this server, then try again.",
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

// mapVolumeCopyUnsupported maps a cross-host data-copy UNIMPLEMENTED (volume OR
// files) to AgentVolumeCopyUnsupportedError; every other error passes through.
export function mapVolumeCopyUnsupported(e: unknown, which: string): Error {
  if (e instanceof AgentVolumeCopyUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentVolumeCopyUnsupportedError(
      `The ${which} server's agent is too old to copy data between servers. Update the agent on that server, then try again.`,
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

// mapCleanupUnsupported maps a DockerCleanup UNIMPLEMENTED to
// AgentCleanupUnsupportedError - an agent can advertise the scope and reject it.
export function mapCleanupUnsupported(e: unknown): Error {
  if (e instanceof AgentCleanupUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentCleanupUnsupportedError(CLEANUP_UNSUPPORTED_MESSAGE);
  }
  return e instanceof Error ? e : new Error(String(e));
}

// mapCronUnsupported maps a cron RPC UNIMPLEMENTED to AgentCronUnsupportedError,
// passing everything else through unchanged.
export function mapCronUnsupported(e: unknown): Error {
  if (e instanceof AgentCronUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentCronUnsupportedError(CRON_UNSUPPORTED_MESSAGE);
  }
  return e instanceof Error ? e : new Error(String(e));
}

// mapBackupUnsupported maps a backup/restore/s3* UNIMPLEMENTED to
// AgentBackupUnsupportedError - an agent that advertised "backup" can still be too
// old to serve the RPC. Every other error passes through unchanged.
export function mapBackupUnsupported(e: unknown): Error {
  if (e instanceof AgentBackupUnsupportedError) return e;
  if (e instanceof AgentBackupStoreUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentBackupUnsupportedError(
      `The agent on this server is too old to run backups. ` +
        `Update the agent on this server, then try again.`,
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

// mapHostOpsUnsupported - UNIMPLEMENTED means the same thing as a missing
// capability: an agent one version behind can advertise it and not implement it.
export function mapHostOpsUnsupported(e: unknown): Error {
  if (e instanceof AgentHostOpsUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentHostOpsUnsupportedError(HOSTOPS_UNSUPPORTED_MESSAGE);
  }
  return e instanceof Error ? e : new Error(String(e));
}
