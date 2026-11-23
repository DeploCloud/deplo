import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  serverRetiredCerts,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { nowIso } from "../../ids";
import { findServerForToken, signBootstrapCsr } from "../../agent/bootstrap";
import { dropAgentChannel } from "../../infra/agent-client/channel-pool";
import { AGENT_VERSION, agentUpdateAvailable } from "../../version";
import { pushRostersForServer } from "../clusters/relay";
import { agentSeen } from "./agent-update-state";
import { agentLinkUrl } from "./panel-address";
import { listAllServers } from "./roster";

export interface BootstrapCallHome {
  token: string;
  csrPem: string;
  advertisedHost?: string;
  /** Where the call came from, as the panel's proxy saw it (ADR-0050). */
  connectedFrom?: string | null;
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
  // Before the token is spent: an answer the agent never gets would leave it nothing to retry with.
  const linkUrl = await agentLinkUrl(server);

  const now = nowIso();
  const won = await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(serversTable)
      .set({
        bootstrapUsedAt: now,
        agentCertFingerprint: signed.fingerprint,
        agentCertPem: signed.certPem,
        agentNextCertFingerprint: null,
        agentNextCertPem: null,
        agentVersion: "",
        status: "online",
        lastSeenAt: now,
        ...(call.connectedFrom ? { connectedFrom: call.connectedFrom } : {}),
      })
      .where(
        sql`${serversTable.id} = ${server.id} and ${serversTable.bootstrapTokenHash} is not null and ${serversTable.bootstrapUsedAt} is null`,
      )
      .returning({ id: serversTable.id });
    // A reinstall replaces the key: a copy still holding the old one is refused as one (ADR-0050).
    if (rows.length > 0 && server.agent?.certPem)
      await tx
        .insert(serverRetiredCerts)
        .values({
          fingerprint: server.agent.certFingerprint,
          serverId: server.id,
          certPem: server.agent.certPem,
          retiredAt: now,
        })
        .onConflictDoNothing();
    return rows;
  });
  if (won.length === 0) {
    throw new Error("bootstrap token was already consumed");
  }
  // A new agent identity: whatever held the old certificate is cut off.
  dropAgentChannel(server.id);
  await pushRostersForServer(server.id);
  return { certPem: signed.certPem, caPem: signed.caPem, linkUrl };
}

/** Its first verified link, kept for good; a Deplo move never inserts servers, so the freeze does not apply. */
export async function recordFirstLink(serverId: string): Promise<void> {
  try {
    const linked = await getDb()
      .update(serversTable)
      .set({ firstLinkedAt: nowIso() })
      .where(
        and(eq(serversTable.id, serverId), isNull(serversTable.firstLinkedAt)),
      )
      .returning({ id: serversTable.id });
    // Trigger an immediate background address scan once a server links for the first time.
    if (linked.length > 0 && !process.env.NODE_TEST_CONTEXT) {
      setTimeout(() => {
        void import("./address-checks")
          .then(({ checkServerAddresses }) => checkServerAddresses())
          .catch((e) =>
            console.error("[addresses] first-link check failed:", e),
          );
      }, 2_000).unref?.();
    }
  } catch (e) {
    // The next link it opens records it.
    console.error(`[deplo] could not record ${serverId}'s first link:`, e);
  }
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
      set.agentVersion = sql`case when ${serversTable.agentCertFingerprint} is not null then ${agentVersion} else ${serversTable.agentVersion} end`;
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
