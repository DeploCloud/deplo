import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { recordActivity } from "../activity";
import { requireInstanceAdmin } from "../../membership";
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
import { HOST_ADDRESS_ERROR, parseHostAddress } from "../../host-address";

export interface UpdateServerAddressInput {
  id: string;
  address: string;
  keepHost?: boolean;
}

/** Where the server's apps are reached; its agent links in, so Deplo never contacts it to save one (ADR-0040). */
export async function updateServerAddress(
  input: UpdateServerAddressInput,
): Promise<void> {
  const { teamId, user, server } = await requireAdminServer(input.id);

  if (!input.address.trim()) throw new Error("Address is required");
  const parsed = parseHostAddress(input.address);
  if (!parsed) throw new Error(HOST_ADDRESS_ERROR);
  const address = parsed.host;
  if (address === server.host && address === server.ip) return;
  await assertAddressFree(address, server.id);

  const updated = await getDb()
    .update(serversTable)
    .set({ ...(input.keepHost ? {} : { host: address }), ip: address })
    .where(eq(serversTable.id, input.id))
    .returning({ id: serversTable.id });
  if (updated.length === 0) throw new Error("Server not found");
  await recordActivity(
    "server",
    `Changed server ${server.name} address to ${address}`,
    user.name,
    null,
    teamId,
  );
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
