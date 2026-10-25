import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { recordActivity } from "../activity";
import { requireInstanceAdmin } from "../../membership";
import { DEFAULT_AGENT_PORT } from "../../agent/bootstrap";
import { resolveAgentRelease } from "../../agent/release";
import { AgentReleaseUnavailableError } from "../../infra/agent-client/errors";
import { LINK_WAIT_MS } from "../../infra/agent-link/protocol";
import {
  hasLinked,
  linkMayCome,
  linksSettling,
  waitForLink,
} from "../../infra/agent-link/registry";
import type { Server } from "../../types/server";
import {
  AGENT_VERSION,
  agentUpdateAvailable,
  reportedAgentVersion,
} from "../../version";
import { attemptAgentUpdate } from "./agent-rollout";
import {
  type AgentUpdateDTO,
  claimAgentUpdate,
  getAgentUpdate,
  toAgentUpdateDTO,
} from "./agent-update-state";
import { assertNotMigrationSource, requireAdminServer } from "./roster";
import { assertAddressFree } from "./enrollment";
import {
  formatHostPort,
  HOST_ADDRESS_ERROR,
  parseHostAddress,
} from "../../host-address";

export interface UpdateServerAddressInput {
  id: string;
  address: string;
  agentPort?: number | null;
  force?: boolean;
  keepHost?: boolean;
}

export async function updateServerAddress(
  input: UpdateServerAddressInput,
): Promise<{ warning: string | null }> {
  const { teamId, user, server } = await requireAdminServer(input.id);

  if (!input.address.trim()) throw new Error("Address is required");
  const parsed = parseHostAddress(input.address);
  if (!parsed) throw new Error(HOST_ADDRESS_ERROR);
  const address = parsed.host;
  if (
    input.agentPort != null &&
    (!Number.isInteger(input.agentPort) ||
      input.agentPort < 1 ||
      input.agentPort > 65535)
  )
    throw new Error("Agent port must be between 1 and 65535");
  const port = input.agentPort ?? server.agent?.port ?? DEFAULT_AGENT_PORT;
  if (
    address === server.host &&
    address === server.ip &&
    port === (server.agent?.port ?? port)
  )
    return { warning: null };
  await assertAddressFree(address, server.id);

  // A linked server is never dialed (ADR-0040): its address is for its apps, its port unused.
  const linked = server.agent?.certFingerprint
    ? await linksIn(server.id)
    : false;
  if (linked && address === server.host && address === server.ip)
    return { warning: null };
  const newPort =
    server.agent && !linked && input.agentPort != null ? input.agentPort : null;
  const warning =
    server.agent?.certFingerprint && !linked
      ? await proveAddress(server, address, port, input.force === true)
      : null;

  const updated = await getDb()
    .update(serversTable)
    .set({
      ...(input.keepHost ? {} : { host: address }),
      ip: address,
      ...(newPort != null ? { agentPort: newPort } : {}),
    })
    .where(eq(serversTable.id, input.id))
    .returning({ id: serversTable.id });
  if (updated.length === 0) throw new Error("Server not found");
  await recordActivity(
    "server",
    `Changed server ${server.name} address to ${
      newPort != null && newPort !== server.agent?.port
        ? formatHostPort(address, newPort)
        : address
    }`,
    user.name,
    null,
    teamId,
  );
  return { warning };
}

/** The port Deplo dials this server's agent on; null when it dials none, because the agent links in or never called home. */
export function dialedAgentPort(server: Server): number | null {
  return server.agent && !hasLinked(server.id) ? server.agent.port : null;
}

// Never dialed: moments after Deplo starts, one that stopped listening may not have linked back yet.
async function linksIn(serverId: string): Promise<boolean> {
  if (linkMayCome(serverId)) return true;
  return (
    linksSettling() && (await waitForLink(serverId, LINK_WAIT_MS)) !== null
  );
}

// A server Deplo still dials: the agent must answer at the new address, unless forced.
async function proveAddress(
  server: Server,
  address: string,
  port: number,
  force: boolean,
): Promise<string | null> {
  let warning: string | null = null;
  const sans = [...new Set([address, server.ip, server.host].filter(Boolean))];
  try {
    const { renewAgentCert } = await import("../../agent/cert-renewal");
    try {
      await renewAgentCert(server.id, sans, {
        ip: address,
        host: address,
        agentPort: port,
      });
    } catch {
      await renewAgentCert(server.id, sans);
    }
  } catch (e) {
    warning =
      (force
        ? `The address was saved without checking it (force). `
        : `The address is saved and Deplo reached the agent there. `) +
      `One thing did not happen: the certificate's list of names could not be ` +
      `refreshed (${e instanceof Error ? e.message : String(e)}). That list is ` +
      `only consulted when this server is dialed by a DNS NAME - an IP verifies ` +
      `by fingerprint and does not touch it - so switch this server to a name ` +
      `before the certificate renews and TLS will fail until it does.`;
  }
  if (!force) {
    const { connectAgentAt } = await import("../../infra/agent-client/connect");
    const conn = await connectAgentAt(server.id, {
      ip: address,
      host: address,
      agentPort: port,
    });
    try {
      await conn.hello();
    } finally {
      conn.close();
    }
  }
  return warning;
}

/** Where this server's agent update stands; null when nothing is in flight or failed. */
export async function serverAgentUpdate(
  id: string,
): Promise<AgentUpdateDTO | null> {
  await requireInstanceAdmin();
  const row = await getAgentUpdate(id);
  return row ? toAgentUpdateDTO(row) : null;
}

/** The Retry now button: only after Deplo's own attempt failed, never two at once. */
export async function retryServerAgentUpdate(
  id: string,
): Promise<AgentUpdateDTO> {
  const { user, server } = await requireAdminServer(id);
  assertNotMigrationSource(server);
  if (!server.agent?.certFingerprint)
    throw new Error(
      "This server is not provisioned yet - finish provisioning before updating its agent",
    );
  if (!agentUpdateAvailable(reportedAgentVersion(server), AGENT_VERSION))
    throw new Error(
      `This server already runs agent v${reportedAgentVersion(server)}. Nothing to update.`,
    );
  const existing = await getAgentUpdate(id);
  if (!existing?.attempts)
    throw new Error(
      "Deplo is updating this server on its own. Retry appears only if that fails.",
    );
  if (!(await resolveAgentRelease())) throw new AgentReleaseUnavailableError();
  const row = await claimAgentUpdate(id, true);
  if (!row) throw new Error("An update is already running on this server.");
  void attemptAgentUpdate(server, row, user.name);
  return toAgentUpdateDTO(row);
}
