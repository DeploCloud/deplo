import { status as GrpcStatus } from "@grpc/grpc-js";

import { ContractVersion, type HelloResponse } from "../agent/gen/agent";
import { LINK_OFFLINE_MESSAGE } from "../agent-reachability";
import {
  AgentOfflineError,
  AgentUnreachableError,
} from "./agent-client/errors";
import type { ServerStatus } from "../types/server";

export interface ServerHealth {
  status: ServerStatus;
  message: string | null;
}

// A closed set because status_message is persisted: a raw transport error is not safe to store.
export const HEALTH_MESSAGES = {
  untrusted:
    "The agent's certificate is not the one we trust for this server. Reissue the install command to re-provision it.",
  certExpired:
    "The agent's certificate has expired (or is not yet valid). The host is up - re-run the install command on this server to re-provision the certificate.",
  contract:
    "The agent speaks an unsupported protocol version. Update the agent on this server.",
  agentError:
    "The agent answered with an error. Check the agent's logs on the host.",
  dockerDown:
    "The agent is up but Docker is unreachable - deploys to this server will fail.",
  // Every server that does not answer, however Deplo reaches it.
  offline: LINK_OFFLINE_MESSAGE,
} as const;

/** A server that answers its dial but never links (ADR-0041): curated around the panel's name alone. */
export function cantReachDeploMessage(panelHost: string | null): string {
  const at = panelHost ? ` at ${panelHost}` : "";
  return `This server can't reach Deplo${at}. Check that it's connected to the internet.`;
}

const CERT_VALIDITY_RE =
  /CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|certificate has expired|certificate is not yet valid/i;

function isCertValidityError(err: AgentUnreachableError): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CERT_VALIDITY_RE.test(code)) return true;
  return CERT_VALIDITY_RE.test(err.message);
}

export function classifyServerHealth(
  hello: HelloResponse | null,
  err: unknown,
  opts: { storageOnly?: boolean } = {},
): ServerHealth {
  if (err instanceof AgentUnreachableError) {
    if (err.trust)
      return { status: "error", message: HEALTH_MESSAGES.untrusted };
    if (isCertValidityError(err))
      return { status: "error", message: HEALTH_MESSAGES.certExpired };
    return { status: "offline", message: HEALTH_MESSAGES.offline };
  }
  if (err) return { status: "error", message: HEALTH_MESSAGES.agentError };
  if (!hello) return { status: "error", message: HEALTH_MESSAGES.agentError };
  if (hello.contractVersion !== ContractVersion.CONTRACT_VERSION_V1)
    return { status: "error", message: HEALTH_MESSAGES.contract };
  if (!hello.dockerAvailable && !opts.storageOnly)
    return { status: "warning", message: HEALTH_MESSAGES.dockerDown };
  return { status: "online", message: null };
}

export function isRetryableProbeFailure(err: unknown): boolean {
  return err instanceof AgentUnreachableError && !err.trust;
}

export function unreachableMessage(err: unknown): string | null {
  if (!(err instanceof AgentUnreachableError)) return null;
  if (err.trust) return HEALTH_MESSAGES.untrusted;
  if (isCertValidityError(err)) return HEALTH_MESSAGES.certExpired;
  if (err.code === GrpcStatus.DEADLINE_EXCEEDED)
    return "This server did not answer in time - it may be overloaded, or unreachable.";
  if (err instanceof AgentOfflineError || typeof err.code === "number")
    return `This server is offline. ${HEALTH_MESSAGES.offline}`;
  return err.message;
}
