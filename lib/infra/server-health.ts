// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { status as GrpcStatus } from "@grpc/grpc-js";

import { ContractVersion, type HelloResponse } from "../agent/gen/agent";
import { AgentUnreachableError } from "./agent-client";
import type { ServerStatus } from "../types";

/**
 * The health CLASSIFIER: given the outcome of one agent `Hello` - a response, or
 * the error it rejected with - decide what the server's status is and what we tell
 * the operator.
 */

export interface ServerHealth {
  status: ServerStatus;
  /**
   * The operator-facing reason, or null when `online`. Drawn from the CLOSED set
   * below - see the warning on {@link classifyServerHealth}.
   */
  message: string | null;
}

/**
 * Every reason string this classifier can produce. A closed set, on purpose:
 * `status_message` is persisted and served over GraphQL, and the raw errors it
 * would otherwise carry are not safe to store.
 */
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
  refused:
    "The agent did not answer (connection refused). Is it running on the host?",
  timedOut: "The agent did not answer within the health-check deadline.",
} as const;

/**
 * Node's TLS layer rejects an EXPIRED (or not-yet-valid) peer certificate with an
 * error whose code is `CERT_HAS_EXPIRED` / `CERT_NOT_YET_VALID` and whose message
 * is "certificate has expired" / "certificate is not yet valid".
 */
const CERT_VALIDITY_RE =
  /CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|certificate has expired|certificate is not yet valid/i;

function isCertValidityError(err: AgentUnreachableError): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CERT_VALIDITY_RE.test(code)) return true;
  return CERT_VALIDITY_RE.test(err.message);
}

/**
 * Classify one Hello outcome. The states, and why each is where it is: - a TRUST
 * failure is `error`, never `offline`.
 */
export function classifyServerHealth(
  hello: HelloResponse | null,
  err: unknown,
  /**
   * A storage-only server holds backups and runs nothing, so it has no Docker on
   * purpose.
   */
  opts: { storageOnly?: boolean } = {},
): ServerHealth {
  if (err instanceof AgentUnreachableError) {
    if (err.trust)
      return { status: "error", message: HEALTH_MESSAGES.untrusted };
    // A cert-validity failure (expired / not-yet-valid) is the host answering with a
    // stale identity, not a dead host - surface it as its own re-bootstrap `error`
    // rather than the misleading "connection refused" it flattens into.
    if (isCertValidityError(err))
      return { status: "error", message: HEALTH_MESSAGES.certExpired };
    return {
      status: "offline",
      message:
        err.code === GrpcStatus.DEADLINE_EXCEEDED
          ? HEALTH_MESSAGES.timedOut
          : HEALTH_MESSAGES.refused,
    };
  }
  if (err) return { status: "error", message: HEALTH_MESSAGES.agentError };
  if (!hello) return { status: "error", message: HEALTH_MESSAGES.agentError };
  if (hello.contractVersion !== ContractVersion.CONTRACT_VERSION_V1)
    return { status: "error", message: HEALTH_MESSAGES.contract };
  if (!hello.dockerAvailable && !opts.storageOnly)
    return { status: "warning", message: HEALTH_MESSAGES.dockerDown };
  return { status: "online", message: null };
}

/**
 * Whether a failed probe is worth retrying once before we demote the server.
 */
export function isRetryableProbeFailure(err: unknown): boolean {
  return err instanceof AgentUnreachableError && !err.trust;
}
