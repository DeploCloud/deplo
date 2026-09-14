import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { recordActivity } from "../activity";
import { DEFAULT_AGENT_PORT } from "../../agent/bootstrap";
import { assertNotMigrationSource, requireAdminServer } from "./roster";

export interface UpdateServerAddressInput {
  id: string;
  // The new dial address (IP or DNS name) - written to BOTH `host` and `ip`,
  // unless `keepHost` says otherwise.
  address: string;
  // New agent gRPC port; omit to keep the current one.
  agentPort?: number | null;
  // Skip the reachability check - for a host not up at the new address yet.
  force?: boolean;
  // Write only `ip` and leave `host` alone - the MIGRATION WIZARD's flag, and the
  // one case where the two are meant to diverge.
  keepHost?: boolean;
}

// updateServerAddress rewrites where Deplo dials a server's agent - the migration
// verb: a VPS got a new IP, or the whole instance moved hosts.
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
      // The NEW address first.
      try {
        await renewAgentCert(server.id, sans, {
          ip: address,
          host: address,
          agentPort: port,
        });
      } catch {
        // The current dial, for the orderly move this was written for - and for
        // `force`, where the new address is not expected to answer yet.
        await renewAgentCert(server.id, sans);
      }
    } catch (e) {
      // Soft on purpose: the force path exists precisely because the old address may
      // already be dead, and an IP-dialed host never consults these SANs.
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
      // `keepHost` leaves `host` as the address the row was BORN with - see the
      // field's own doc. Everywhere else the two stay identical.
      ...(input.keepHost ? {} : { host: address }),
      ip: address,
      // Meaningless before an agent exists - bootstrap sets it when one calls home.
      ...(server.agent && input.agentPort != null
        ? { agentPort: input.agentPort }
        : {}),
    })
    .where(eq(serversTable.id, input.id))
    .returning({ id: serversTable.id });
  // The probe window is real: a concurrent removeServer between the read above
  // and this write must surface as a refusal, not as success + phantom activity.
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

// updateServerAgent updates a server's agent binary in place to the latest
// released version WITHOUT reissuing its certificates.
export async function updateServerAgent(
  id: string,
): Promise<{ version: string }> {
  const { teamId, user, server } = await requireAdminServer(id);
  // Not on a migration source: upgrading the agent on another platform's machine
  // is maintenance of a host we do not run. Reachable from MCP, so the refusal
  // lives here.
  assertNotMigrationSource(server);
  if (!server.agent?.certFingerprint)
    throw new Error(
      "This server is not provisioned yet - finish provisioning before updating its agent",
    );

  // Lazy-import to keep the grpc agent-client (and its deps) out of modules that
  // never reach an agent.
  const { selfUpdateServerAgent } =
    await import("../../infra/agent-client/agent-lifecycle");
  const result = await selfUpdateServerAgent(id);

  // The next Hello (markServerSeen) refreshes it from the live agent regardless,
  // so this is just a faster echo.
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
