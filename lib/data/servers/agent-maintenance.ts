import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { recordActivity } from "../activity";
import { DEFAULT_AGENT_PORT } from "../../agent/bootstrap";
import { agentChannel } from "../../agent/release";
import { assertNotMigrationSource, requireAdminServer } from "./roster";

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

  const address = input.address.trim();
  if (!address) throw new Error("Address is required");
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
    `Changed server ${server.name} address to ${address}:${port}`,
    user.name,
    null,
    teamId,
  );
  return { warning };
}

export async function updateServerAgent(
  id: string,
): Promise<{ version: string }> {
  const { teamId, user, server } = await requireAdminServer(id);
  assertNotMigrationSource(server);
  if (!server.agent?.certFingerprint)
    throw new Error(
      "This server is not provisioned yet - finish provisioning before updating its agent",
    );

  const { selfUpdateServerAgent } =
    await import("../../infra/agent-client/agent-lifecycle");
  const result = await selfUpdateServerAgent(id, agentChannel(server));

  await getDb()
    .update(serversTable)
    .set({ agentVersion: result.version })
    .where(eq(serversTable.id, id));
  await recordActivity(
    "server",
    `Updated agent on ${server.name} to v${result.version}`,
    user.name,
    null,
    teamId,
  );
  return result;
}
