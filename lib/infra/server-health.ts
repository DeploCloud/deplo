import { status as GrpcStatus } from "@grpc/grpc-js";

import { ContractVersion, type HelloResponse } from "../agent/gen/agent";
import { AgentUnreachableError } from "./agent-client";
import type { ServerStatus } from "../types";

/**
 * The health CLASSIFIER: given the outcome of one agent `Hello` — a response, or
 * the error it rejected with — decide what the server's status is and what we tell
 * the operator.
 *
 * It is a pure function, deliberately hoisted out of the dial. There is no mocking
 * seam for `connectAgent` in this repo (grpc is real, `dial`/`resolveTarget` are
 * module-private), so a decision welded to the RPC — the shape `metricsFor` uses —
 * is a decision that can never be tested. Everything that is actually hard here
 * (which failures are the host's fault, which are the agent's, which must never be
 * persisted) lives in this file and is exercised by lib/infra/server-health.test.ts
 * without a socket. Mirrors `reconcileStatus` / `isAgentOutdated` / `agentCanHandle`.
 */

export interface ServerHealth {
  status: ServerStatus;
  /**
   * The operator-facing reason, or null when `online`. Drawn from the CLOSED set
   * below — see the warning on {@link classifyServerHealth}.
   */
  message: string | null;
}

/**
 * Every reason string this classifier can produce. A closed set, on purpose:
 * `status_message` is persisted and served over GraphQL, and the raw errors it
 * would otherwise carry are not safe to store. `checkServerIdentity`'s text embeds
 * the PINNED FINGERPRINT (our trust anchor); grpc-js `UNAVAILABLE` details routinely
 * embed the dial address (`10.x.x.x:9443`); `resolveTarget`'s errors embed the
 * server name. None of that belongs in a column. The raw error goes to the server
 * log, where an operator with shell access — who already has all of it — can read it.
 */
export const HEALTH_MESSAGES = {
  untrusted:
    "The agent's certificate is not the one we trust for this server. Reissue the install command to re-provision it.",
  contract:
    "The agent speaks an unsupported protocol version. Update the agent on this server.",
  agentError: "The agent answered with an error. Check the agent's logs on the host.",
  dockerDown:
    "The agent is up but Docker is unreachable — deploys to this server will fail.",
  refused: "The agent did not answer (connection refused). Is it running on the host?",
  timedOut: "The agent did not answer within the health-check deadline.",
} as const;

/**
 * Classify one Hello outcome. Exactly one of `hello` / `err` is meaningful: pass the
 * response on success, the thrown error on failure.
 *
 * The states, and why each is where it is:
 *
 *  - a TRUST failure is `error`, never `offline`. The peer answered — it just isn't
 *    the agent whose cert we pinned (or it rejected ours). Reporting that as "offline"
 *    would send the operator to check a host that is up, and would bury what is
 *    potentially a MITM or a half-finished re-provision. `AgentUnreachableError.trust`
 *    is set by `dial` because gRPC flattens the TLS rejection into an opaque
 *    UNAVAILABLE that is otherwise indistinguishable from a dead box.
 *  - a contract mismatch or any application-level gRPC error is `error` for the same
 *    reason: the box is up, its agent is wrong.
 *  - `warning` has exactly ONE member — Docker unreachable — and it means "the agent
 *    is up and trusted, but nothing can be deployed here". It is deliberately NOT
 *    used for a stopped Traefik (legitimate on a DB/worker host, and it already has
 *    its own live badge) nor for an outdated agent (deploys fine, has its own badge).
 *    A warning that fires on a normal configuration is a warning operators learn to
 *    ignore.
 *  - everything else — connection refused, no answer inside the deadline — is
 *    `offline`. The CALLER is responsible for confirming that with a retry before it
 *    persists a demotion (see `probeServer`); a single missed packet is not an outage.
 *
 * There is intentionally no "unknown" state. A probe that we could not complete
 * (wrapper timeout, throttled, skipped) is not classified at all — the caller writes
 * nothing and the row keeps its previous observation. Stamping a fresh check we did
 * not perform is the same lie as a stale green badge, just better hidden.
 */
export function classifyServerHealth(
  hello: HelloResponse | null,
  err: unknown,
): ServerHealth {
  if (err instanceof AgentUnreachableError) {
    if (err.trust) return { status: "error", message: HEALTH_MESSAGES.untrusted };
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
  if (!hello.dockerAvailable)
    return { status: "warning", message: HEALTH_MESSAGES.dockerDown };
  return { status: "online", message: null };
}

/**
 * Whether a failed probe is worth retrying once before we demote the server. A
 * transport blip (a dropped packet, the agent re-exec'ing mid self-update) must not
 * be persisted as an outage; a trust failure or an application error is a stable fact
 * that a retry would only confirm more slowly.
 */
export function isRetryableProbeFailure(err: unknown): boolean {
  return err instanceof AgentUnreachableError && !err.trust;
}
