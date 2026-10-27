import "server-only";

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { nowIso } from "../../ids";
import {
  findServerForToken,
  signBootstrapCsr,
  DEFAULT_AGENT_PORT,
} from "../../agent/bootstrap";
import { dropAgentChannel } from "../../infra/agent-client/channel-pool";
import { AGENT_VERSION, agentUpdateAvailable } from "../../version";
import { tryPassThisStop } from "../update-stops/decision";
import { agentSeen } from "./agent-update-state";
import { agentLinkUrl } from "./panel-address";
import { listAllServers } from "./roster";

export interface BootstrapCallHome {
  token: string;
  csrPem: string;
  agentPort?: number;
  advertisedHost?: string;
}

export interface BootstrapCompletion {
  certPem: string;
  caPem: string;
  /** The agent's primary link address: the control plane chooses it (ADR-0040). */
  linkUrl: string;
}

export async function completeBootstrap(
  call: BootstrapCallHome,
): Promise<BootstrapCompletion> {
  const server = findServerForToken(await listAllServers(), call.token);
  const dialHosts = [server.ip, server.host].filter(Boolean);
  const signed = await signBootstrapCsr(call.csrPem, dialHosts);
  const port =
    call.agentPort && call.agentPort > 0 ? call.agentPort : DEFAULT_AGENT_PORT;
  // Before the token is spent: an answer the agent never gets would leave it nothing to retry with.
  const linkUrl = await agentLinkUrl(server);

  const now = nowIso();
  const won = await getDb()
    .update(serversTable)
    .set({
      bootstrapUsedAt: now,
      agentPort: port,
      agentCertFingerprint: signed.fingerprint,
      agentCertPem: signed.certPem,
      agentVersion: "",
      status: "online",
      lastSeenAt: now,
    })
    .where(
      sql`${serversTable.id} = ${server.id} and ${serversTable.bootstrapTokenHash} is not null and ${serversTable.bootstrapUsedAt} is null`,
    )
    .returning({ id: serversTable.id });
  if (won.length === 0) {
    throw new Error("bootstrap token was already consumed");
  }
  // A new agent identity: whatever held the old certificate is cut off.
  dropAgentChannel(server.id);
  return { certPem: signed.certPem, caPem: signed.caPem, linkUrl };
}

/** The provisioned server pinned to this agent certificate: what an agent link claims to be. */
export async function serverPinnedTo(
  fingerprint: string,
): Promise<{ id: string } | null> {
  if (!fingerprint) return null;
  const [row] = await getDb()
    .select({ id: serversTable.id })
    .from(serversTable)
    .where(
      and(
        eq(serversTable.agentCertFingerprint, fingerprint),
        isNotNull(serversTable.agentPort),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Its first verified link, kept for good; a Deplo move never inserts servers, so the freeze does not apply. */
export async function recordFirstLink(serverId: string): Promise<void> {
  let first = false;
  try {
    const set = await getDb()
      .update(serversTable)
      .set({ firstLinkedAt: nowIso() })
      .where(
        and(eq(serversTable.id, serverId), isNull(serversTable.firstLinkedAt)),
      )
      .returning({ id: serversTable.id });
    first = set.length > 0;
  } catch (e) {
    // The next link it opens records it.
    console.error(`[deplo] could not record ${serverId}'s first link:`, e);
  }
  // The last server to connect passes this release's update stop now; failing that, the next update check does.
  if (first) await tryPassThisStop();
}

export function observedTraefik(hello: {
  dockerAvailable: boolean;
  traefikRunning: boolean;
}): boolean | undefined {
  return hello.dockerAvailable ? hello.traefikRunning : undefined;
}

export async function markServerSeen(
  id: string,
  agentVersion?: string,
  traefikRunning?: boolean,
  specs?: { cpuCores: number; memoryMb: number; diskGb: number },
  dockerVersion?: string,
  hostArch?: string,
): Promise<void> {
  try {
    const set: Record<string, unknown> = { lastSeenAt: nowIso() };
    if (agentVersion)
      set.agentVersion = sql`case when ${serversTable.agentPort} is not null then ${agentVersion} else ${serversTable.agentVersion} end`;
    if (typeof traefikRunning === "boolean")
      set.traefikEnabled = traefikRunning;
    if (dockerVersion) set.dockerVersion = dockerVersion;
    if (hostArch) set.hostArch = hostArch;
    if (specs && specs.cpuCores > 0) {
      set.cpuCores = specs.cpuCores;
      set.memoryMb = specs.memoryMb;
      set.diskGb = specs.diskGb;
    }
    await getDb().update(serversTable).set(set).where(eq(serversTable.id, id));
    // ponytail: one primary-key statement per Hello; fold into the update above if it ever shows up.
    if (agentVersion)
      await agentSeen(id, !agentUpdateAvailable(agentVersion, AGENT_VERSION));
  } catch (e) {
    console.error("[deplo] markServerSeen failed:", e);
  }
}
