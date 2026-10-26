import "server-only";

import { status as GrpcStatus, type ServiceError } from "@grpc/grpc-js";

import { AGENT_TOO_OLD_MESSAGE, agentUsable } from "../../version";
import { LINK_WAIT_MS } from "../agent-link/protocol";

export { AGENT_TOO_OLD_MESSAGE };

export class AgentUnreachableError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly trust?: boolean,
  ) {
    super(message);
  }
}

/** A server that links, whose link stayed away past the wait (ADR-0040). */
export class AgentOfflineError extends AgentUnreachableError {
  constructor(serverId: string) {
    super(
      `server ${serverId} is offline: its agent has not connected for ${LINK_WAIT_MS / 1000} s`,
    );
  }
}

export class AgentNetworkUnsupportedError extends Error {}

// An agent below the panel's agentMin: unusable until it updates (ADR-0037).
export class AgentTooOldError extends Error {
  constructor(readonly agentVersion: string) {
    super(AGENT_TOO_OLD_MESSAGE);
  }
}

export function assertAgentUsable(agentVersion: string): void {
  if (!agentUsable(agentVersion)) throw new AgentTooOldError(agentVersion);
}

export class AgentUpdateUnsupportedError extends Error {}

// Raised before any agent is dialed, so a GitHub outage never counts against a server.
export class AgentReleaseUnavailableError extends Error {
  constructor() {
    super(
      "Could not download the agent release this Deplo installs from GitHub. Try again in a minute.",
    );
  }
}

export class AgentUninstallUnsupportedError extends Error {}

export class AgentBackupUnsupportedError extends Error {}

export class AgentBackupStoreUnsupportedError extends Error {}

export class AgentMetricsStreamUnsupportedError extends Error {}

export class AgentCheckPortUnsupportedError extends Error {}

export class AgentVolumeCopyUnsupportedError extends Error {}

export class AgentCleanupUnsupportedError extends Error {}

export class AgentCronUnsupportedError extends Error {}

export class AgentHostOpsUnsupportedError extends Error {}

export class AgentControlPlaneUpdateUnsupportedError extends Error {}

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

const TRANSPORT_DOWN_CODES = new Set<number>([
  GrpcStatus.UNAVAILABLE,
  GrpcStatus.DEADLINE_EXCEEDED,
  GrpcStatus.UNAUTHENTICATED,
]);

export function toAgentError(err: unknown): Error {
  if (err instanceof AgentUnreachableError) return err;
  const code = (err as Partial<ServiceError> | null)?.code;
  if (typeof code === "number" && TRANSPORT_DOWN_CODES.has(code)) {
    const msg = err instanceof Error ? err.message : String(err);
    return new AgentUnreachableError(msg, code);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export type LogsFailure = "unreachable" | "not-found" | "denied" | "failed";

export function logsFailureReason(err: unknown): LogsFailure {
  if (toAgentError(err) instanceof AgentUnreachableError) return "unreachable";
  const code = (err as Partial<ServiceError> | null)?.code;
  if (code === GrpcStatus.NOT_FOUND) return "not-found";
  if (code === GrpcStatus.PERMISSION_DENIED) return "denied";
  return "failed";
}

export function mapCheckPortUnsupported(e: unknown): Error {
  if (e instanceof AgentCheckPortUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentCheckPortUnsupportedError(
      "This server's agent is too old to check port availability. Update the agent on this server, then try again.",
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

export function mapVolumeCopyUnsupported(e: unknown, which: string): Error {
  if (e instanceof AgentVolumeCopyUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentVolumeCopyUnsupportedError(
      `The ${which} server's agent is too old to copy data between servers. Update the agent on that server, then try again.`,
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

export function mapCleanupUnsupported(e: unknown): Error {
  if (e instanceof AgentCleanupUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentCleanupUnsupportedError(CLEANUP_UNSUPPORTED_MESSAGE);
  }
  return e instanceof Error ? e : new Error(String(e));
}

export function mapCronUnsupported(e: unknown): Error {
  if (e instanceof AgentCronUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentCronUnsupportedError(CRON_UNSUPPORTED_MESSAGE);
  }
  return e instanceof Error ? e : new Error(String(e));
}

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

export function mapHostOpsUnsupported(e: unknown): Error {
  if (e instanceof AgentHostOpsUnsupportedError) return e;
  if ((e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED) {
    return new AgentHostOpsUnsupportedError(HOSTOPS_UNSUPPORTED_MESSAGE);
  }
  return e instanceof Error ? e : new Error(String(e));
}
