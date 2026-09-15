import "server-only";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { nowIso } from "../../ids";
import {
  findServerForToken,
  signBootstrapCsr,
  DEFAULT_AGENT_PORT,
} from "../../agent/bootstrap";
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
}

export async function completeBootstrap(
  call: BootstrapCallHome,
): Promise<BootstrapCompletion> {
  const server = findServerForToken(await listAllServers(), call.token);
  const dialHosts = [server.ip, server.host].filter(Boolean);
  const signed = await signBootstrapCsr(call.csrPem, dialHosts);
  const port =
    call.agentPort && call.agentPort > 0 ? call.agentPort : DEFAULT_AGENT_PORT;

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
  return { certPem: signed.certPem, caPem: signed.caPem };
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
  } catch (e) {
    console.error("[deplo] markServerSeen failed:", e);
  }
}
