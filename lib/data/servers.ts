import "server-only";

import { headers } from "next/headers";
import { read, mutate } from "../store";
import { assertUser } from "../auth";
import { requireCapability } from "../membership";
import { newId, nowIso } from "../ids";
import { resolvePublicBaseUrl } from "../public-url";
import { recordActivity } from "./activity";
import {
  mintBootstrap,
  installCommand,
  controlPlaneCertFingerprint,
  findServerForToken,
  signBootstrapCsr,
  DEFAULT_AGENT_PORT,
} from "../agent/bootstrap";
import type { Server } from "../types";

export async function listServers(): Promise<Server[]> {
  await assertUser();
  // Master (localhost) first, then remotes by creation order.
  return [...read().servers].sort((a, b) => {
    if (a.type === b.type) return a.createdAt < b.createdAt ? -1 : 1;
    return a.type === "localhost" ? -1 : 1;
  });
}

export async function getServer(id: string): Promise<Server | null> {
  await assertUser();
  return read().servers.find((x) => x.id === id) || null;
}

export async function getPrimaryServer(): Promise<Server> {
  await assertUser();
  return (
    read().servers.find((s) => s.type === "localhost") ?? read().servers[0]
  );
}

export interface AddServerInput {
  name: string;
  host: string;
}

/** What addServer returns: the new row plus the one-time install command (P1). */
export interface AddServerResult {
  server: Server;
  /**
   * The paste-on-the-server command the operator runs to provision the agent.
   * Shown ONCE (it embeds the single-use bootstrap token); the control plane
   * stores only the token's hash. The UI must surface this immediately.
   */
  installCommand: string;
}

/**
 * Register a remote server (PLAN Part B, P1). No SSH-in: the control plane never
 * holds the server's root credential. Instead it mints a one-time bootstrap
 * token, records the server in `provisioning`, and returns a paste-on-the-server
 * install command. The operator runs it; the agent calls home (see
 * app/api/agent/bootstrap), gets its CSR signed, and the server flips to
 * `online`. The old `sshUser`/`sshPort` fields are gone — the call-home model
 * never uses them (PLAN P1).
 */
export async function addServer(input: AddServerInput): Promise<AddServerResult> {
  const { membership } = await requireCapability("manage_infra");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const host = input.host.trim();

  const { rawToken, stored } = mintBootstrap();
  const baseUrl = resolvePublicBaseUrl(await headers());
  // Best-effort: read the control plane's own TLS fingerprint to pin in the
  // command (P3). Empty over plain HTTP — the agent then uses the HMAC path.
  const fingerprint = await controlPlaneCertFingerprint(baseUrl);

  const server: Server = {
    id: newId("srv"),
    name: input.name.trim() || host,
    host,
    type: "remote",
    status: "provisioning",
    ip: host,
    dockerVersion: "",
    traefikEnabled: false,
    cpuCores: 0,
    memoryMb: 0,
    diskGb: 0,
    cpuUsage: 0,
    memoryUsage: 0,
    diskUsage: 0,
    createdAt: nowIso(),
    bootstrap: stored,
  };
  mutate((d) => d.servers.push(server));
  recordActivity("member", `Connected server ${server.name}`, user.name, null, membership.teamId);

  return {
    server,
    installCommand: installCommand({ baseUrl, rawToken, fingerprint }),
  };
}

/**
 * Re-mint a fresh bootstrap token + install command for a server still in
 * `provisioning` (the original token expired, or the operator lost the command).
 * Refuses an already-provisioned server (it has trust material; re-bootstrapping
 * would be a re-provision, which goes through removal first).
 */
export async function reissueBootstrap(id: string): Promise<AddServerResult> {
  await requireCapability("manage_infra");
  const server = read().servers.find((s) => s.id === id);
  if (!server) throw new Error("Server not found");
  if (server.type === "localhost")
    throw new Error("The master server is not provisioned this way");
  if (server.agent)
    throw new Error("This server is already provisioned; remove it to re-provision");

  const { rawToken, stored } = mintBootstrap();
  const baseUrl = resolvePublicBaseUrl(await headers());
  const fingerprint = await controlPlaneCertFingerprint(baseUrl);
  mutate((d) => {
    const s = d.servers.find((x) => x.id === id);
    if (s) {
      s.bootstrap = stored;
      s.status = "provisioning";
    }
  });
  const fresh = read().servers.find((s) => s.id === id)!;
  return { server: fresh, installCommand: installCommand({ baseUrl, rawToken, fingerprint }) };
}

/**
 * Remove a remote server with the ordered three-move teardown (PLAN P6):
 *   (a) ALWAYS revoke trust first — drop the pinned cert — even if the box is
 *       dead, so a removed server never keeps a valid badge;
 *   (b) BLOCK removal while projects are still assigned — the operator
 *       reassigns or deletes them first, consciously (no silent re-home);
 *   (c) BEST-EFFORT remote teardown — pre-flight Hello, and if the agent
 *       answers, tell it to tear down its stacks; if unreachable, proceed with
 *       removal anyway and warn that leftover containers need a manual cleanup.
 *
 * Returns a warning string when (c) could not complete (the agent was
 * unreachable), or null on a clean teardown.
 */
export async function removeServer(id: string): Promise<{ warning: string | null }> {
  const { membership } = await requireCapability("manage_infra");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const server = read().servers.find((s) => s.id === id);
  if (!server) throw new Error("Server not found");
  if (server.type === "localhost")
    throw new Error("The master server cannot be removed");

  // (b) Block while projects are assigned — a conscious decision by the operator.
  if (read().projects.some((p) => p.serverId === id))
    throw new Error("Move or delete projects on this server first");

  // Snapshot the trust material BEFORE revoking. `read()` returns the live cache,
  // so `server` is a reference the revoke mutate below clears in place — capture
  // a frozen copy now (with its original pinned cert) so the teardown can still
  // dial the agent, and so the "was it provisioned?" decision is the pre-revoke
  // truth, not the post-revoke "".
  const snapshot: Server = { ...server, agent: server.agent ? { ...server.agent } : undefined };
  const wasProvisioned = Boolean(server.agent?.certFingerprint) || server.status === "online";

  // (a) Revoke trust FIRST, unconditionally: clear the pinned cert so even if
  // every later step fails, the agent's badge is already dead. Persisted before
  // any network call so a crash mid-teardown still leaves trust revoked.
  mutate((d) => {
    const s = d.servers.find((x) => x.id === id);
    if (s?.agent) s.agent.certFingerprint = "";
  });

  // (c) Best-effort remote teardown. Import lazily so removing a server doesn't
  // force the agent-client (and its grpc deps) into modules that never deploy.
  // Dial via the pre-revoke snapshot (the live row's pin is now cleared).
  let warning: string | null = null;
  if (wasProvisioned) {
    try {
      const { teardownServerAgent } = await import("../infra/agent-client");
      await teardownServerAgent(snapshot);
    } catch (e) {
      warning =
        `Could not reach the agent on ${server.name} to tear down its containers ` +
        `(${e instanceof Error ? e.message : String(e)}). Remove leftover ` +
        `deplo-* containers on that host by hand.`;
    }
  }

  mutate((d) => {
    d.servers = d.servers.filter((s) => s.id !== id);
  });
  recordActivity("member", `Removed server ${server.name}`, user.name, null, membership.teamId);
  return { warning };
}

/** What a calling-home agent sends, and what completeBootstrap signs against. */
export interface BootstrapCallHome {
  /** The raw one-time token from the install command. */
  token: string;
  /** The agent's PKCS#10 CSR (its own key never leaves the box). */
  csrPem: string;
  /** The gRPC port the agent will listen on (default 9443). */
  agentPort?: number;
  /**
   * The address the agent believes it is reachable at — informational only. The
   * control plane dials the SERVER ROW's host/ip (operator-declared), not a
   * self-reported address, so a compromised agent can't redirect future dials.
   */
  advertisedHost?: string;
}

/** The signed material returned to a calling-home agent. */
export interface BootstrapCompletion {
  certPem: string;
  caPem: string;
}

/**
 * Complete a call-home bootstrap (PLAN P1-P4). UNAUTHENTICATED entry point (the
 * caller is a brand-new agent, not a logged-in user) — its trust comes entirely
 * from the single-use token + the CSR proof-of-possession, NOT from a session.
 * Validates the token against a provisioning server, signs the agent's CSR with
 * the control-plane CA using the SERVER ROW's declared address as the cert SANs
 * (never a self-reported one), then atomically pins the cert fingerprint, clears
 * the bootstrap token (single-use), and flips `provisioning -> online`.
 *
 * The check-sign-consume is split: signing (CSR crypto) happens outside the
 * mutate, then a single mutate re-validates the token is still unused and pins
 * the result, so a double-submit can't provision twice (the loser sees the token
 * already consumed and throws).
 */
export async function completeBootstrap(
  call: BootstrapCallHome,
): Promise<BootstrapCompletion> {
  // Validate against the current store (throws a typed BootstrapError on a bad
  // / expired / used token).
  const server = findServerForToken(read().servers, call.token);
  // The cert SANs are the address WE will dial — the operator-declared host/ip
  // on the row, plus a self-reported host only if it matches (defence in depth).
  const dialHosts = [server.ip, server.host].filter(Boolean);
  const signed = await signBootstrapCsr(call.csrPem, dialHosts);
  const port = call.agentPort && call.agentPort > 0 ? call.agentPort : DEFAULT_AGENT_PORT;

  // Atomic consume + pin: re-find under the lock and re-check the token is still
  // unused so concurrent call-homes can't both provision.
  let consumed = false;
  mutate((d) => {
    const s = d.servers.find((x) => x.id === server.id);
    if (!s || !s.bootstrap || s.bootstrap.usedAt) return; // lost the race
    s.bootstrap.usedAt = nowIso();
    s.agent = {
      port,
      certFingerprint: signed.fingerprint,
      certPem: signed.certPem,
      version: "",
    };
    s.status = "online";
    s.lastSeenAt = nowIso();
    consumed = true;
  });
  if (!consumed) {
    throw new Error("bootstrap token was already consumed");
  }
  return { certPem: signed.certPem, caPem: signed.caPem };
}

/**
 * Mark a server seen now (P5 heartbeat cache). A best-effort write behind the
 * live-read health check — never the source of truth for status.
 */
export function markServerSeen(id: string, agentVersion?: string): void {
  mutate((d) => {
    const s = d.servers.find((x) => x.id === id);
    if (!s) return;
    s.lastSeenAt = nowIso();
    if (agentVersion && s.agent) s.agent.version = agentVersion;
  });
}
