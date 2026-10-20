import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { recordActivity } from "../activity";
import { requireInstanceAdmin } from "../../membership";
import { DEFAULT_AGENT_PORT } from "../../agent/bootstrap";
import { resolveAgentRelease } from "../../agent/release";
import { AgentReleaseUnavailableError } from "../../infra/agent-client/errors";
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

  let warning: string | null = null;
  if (server.agent?.certFingerprint) {
    const sans = [
      ...new Set([address, server.ip, server.host].filter(Boolean)),
    ];
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
        (input.force
          ? `The address was saved without checking it (force). `
          : `The address is saved and Deplo reached the agent there. `) +
        `One thing did not happen: the certificate's list of names could not be ` +
        `refreshed (${e instanceof Error ? e.message : String(e)}). That list is ` +
        `only consulted when this server is dialed by a DNS NAME - an IP verifies ` +
        `by fingerprint and does not touch it - so switch this server to a name ` +
        `before the certificate renews and TLS will fail until it does.`;
    }
    if (!input.force) {
      const { connectAgentAt } =
        await import("../../infra/agent-client/connect");
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
  }

  const updated = await getDb()
    .update(serversTable)
    .set({
      ...(input.keepHost ? {} : { host: address }),
      ip: address,
      ...(server.agent && input.agentPort != null
        ? { agentPort: input.agentPort }
        : {}),
    })
    .where(eq(serversTable.id, input.id))
    .returning({ id: serversTable.id });
  if (updated.length === 0) throw new Error("Server not found");
  await recordActivity(
    "server",
    `Changed server ${server.name} address to ${formatHostPort(address, port)}`,
    user.name,
    null,
    teamId,
  );
  return { warning };
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
