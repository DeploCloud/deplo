import "server-only";

import { eq } from "drizzle-orm";

import { listDevSshUsersForServices } from "../data/dev-ssh";
import { getDb } from "../db/client";
import { services as servicesTable } from "../db/schema/control-plane";
import { loadServiceGraph } from "../data/service-graph-load";
import { decryptSecret } from "../crypto";
import { connectAgent } from "./agent-client";
import type { AgentGatewayConfig, AgentGatewayStep } from "./agent-client";
import {
  GATEWAY_PROJECT,
  GATEWAY_CONTAINER,
  GATEWAY_PORT,
  WRAPPER_SCRIPT,
  SSHD_CONFIG,
  GATEWAY_ENTRYPOINT,
  SOCKET_FILTER_CFG,
  renderGatewayCompose,
} from "./gateway-config";
import {
  provisionSteps,
  deprovisionSteps,
  type GatewayTarget,
} from "./gateway-projection";
import type { DevSshUser } from "../types";

// Re-export the identity constants so existing callers keep importing them here.
export { GATEWAY_PROJECT, GATEWAY_CONTAINER, GATEWAY_PORT };

// ---------------------------------------------------------------------------
// PART D: the SSH gateway moved to the per-host agent (ADR-0002 singleton). The
// store's DevSshUser[] stays the SOLE source of truth in the control plane; the
// running gateway container is a disposable projection of it that now lives on
// the OWNING SERVER's host. This module keeps the pure RENDERING — the config
// files (gateway-config.ts) and the per-user exec-step plan (gateway-projection.ts)
// — as the single source of truth (snapshot-tested), and ships them to the agent
// over EnsureGateway / ProvisionSshUser / DeprovisionSshUser. The agent writes the
// files, brings the 2-service stack up, and runs the steps; the security-critical
// wrapper / sshd_config / allowlist are never re-implemented in Go.
//
// The gateway's compose bind path is host-specific (the agent owns its own
// <data>/ssh-gateway dir), so the compose is rendered with a SENTINEL the agent
// substitutes for its real path — see GATEWAY_HOST_DIR_SENTINEL.
// ---------------------------------------------------------------------------

/** Must match gatewayHostDirSentinel in agent/internal/server/sshgateway.go. */
const GATEWAY_HOST_DIR_SENTINEL = "__DEPLO_GW_HOST_DIR__";

/** The rendered gateway config the agent writes to its own bind mount. The
 *  compose's bind source is the sentinel; the agent fills in its real path. */
function gatewayConfig(): AgentGatewayConfig {
  return {
    composeYaml: renderGatewayCompose(GATEWAY_HOST_DIR_SENTINEL),
    sshdConfig: SSHD_CONFIG,
    wrapperScript: WRAPPER_SCRIPT,
    entrypointScript: GATEWAY_ENTRYPOINT,
    socketFilterCfg: SOCKET_FILTER_CFG,
  };
}

/** The owning server id of a dev SSH user (via its project, relational). */
async function serverIdForUser(user: DevSshUser): Promise<string | null> {
  const p = await loadServiceGraph(user.serviceId);
  return p?.serverId ?? null;
}

/** Render one user's provision step-list (the pure projection). The password is
 *  decrypted just-in-time and baked into the right step's stdin; the cleartext
 *  never leaves this call frame as ciphertext. Returns [] if the user's project
 *  (and thus its dev container target) is gone. `slugByService` is the resolved
 *  project→slug map (relational) so this stays a pure projection. */
function userProvisionSteps(
  user: DevSshUser,
  slugByService: Map<string, string>,
): AgentGatewayStep[] {
  const slug = slugByService.get(user.serviceId);
  if (!slug) return [];
  const target: GatewayTarget = { slug, container: `deplo-dev-${slug}` };
  return provisionSteps(
    {
      username: user.username,
      password: user.passwordEnc ? decryptSecret(user.passwordEnc) : null,
      publicKey: user.publicKey ?? null,
    },
    target,
  ).map((s) => ({ argv: s.argv, input: s.input ?? "" }));
}

/** The full reconcile set for a server: every stored DevSshUser whose project
 *  lives on that server (devSshUsers JSONB; services relational — ADR-0002), each
 *  as its step-list. Sending the WHOLE set lets a freshly-created gateway rebuild
 *  its projection. */
async function serverUserSteps(serverId: string): Promise<AgentGatewayStep[][]> {
  // The server's services (relational), as a serviceId → slug map.
  const serviceRows = await getDb()
    .select({ id: servicesTable.id, slug: servicesTable.slug })
    .from(servicesTable)
    .where(eq(servicesTable.serverId, serverId));
  const slugByService = new Map(serviceRows.map((p) => [p.id, p.slug] as const));
  const users = await listDevSshUsersForServices([...slugByService.keys()]);
  return users
    .map((u) => userProvisionSteps(u, slugByService))
    .filter((steps) => steps.length > 0);
}

/**
 * Lazily ensure the gateway on a server (ADR-0002) — never at install. Routes to
 * the owning agent: ensure the 2-service stack is up and reconcile every stored
 * user of that server into it. Idempotent. Mirrors the old in-process ensureGateway.
 */
export async function ensureGateway(serverId: string): Promise<void> {
  const steps = await serverUserSteps(serverId);
  const conn = await connectAgent(serverId);
  try {
    await conn.ensureGateway(gatewayConfig(), steps);
  } finally {
    conn.close();
  }
}

/**
 * Provision one user inside the gateway on its server. Ensures the gateway first
 * (the user may be the first SSH user → lazy create) and reconciles the full set,
 * so the just-created gateway rebuilds from the store. The store leads; this
 * follows. Resolves the server from the user's project.
 */
export async function provisionUser(user: DevSshUser): Promise<void> {
  const serverId = await serverIdForUser(user);
  if (!serverId) return;
  const steps = await serverUserSteps(serverId);
  const conn = await connectAgent(serverId);
  try {
    await conn.provisionSshUser(gatewayConfig(), steps);
  } finally {
    conn.close();
  }
}

/**
 * Remove one user from the gateway on its server (account + key + map files).
 * No-op if the agent isn't reachable or the gateway isn't running. The store has
 * already dropped the user (the driver calls this after the store write).
 */
export async function deprovisionUser(
  serverId: string,
  username: string,
): Promise<void> {
  const steps = deprovisionSteps(username).map((s) => ({
    argv: s.argv,
    input: s.input ?? "",
  }));
  const conn = await connectAgent(serverId);
  try {
    await conn.deprovisionSshUser(steps);
  } finally {
    conn.close();
  }
}
