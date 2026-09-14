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

// What a calling-home agent sends, and what completeBootstrap signs against.
export interface BootstrapCallHome {
  // The raw one-time token from the install command.
  token: string;
  // The agent's PKCS#10 CSR (its own key never leaves the box).
  csrPem: string;
  // The gRPC port the agent will listen on (default 9443).
  agentPort?: number;
  // Informational only: the control plane dials the SERVER ROW's host/ip
  // (operator-declared), so a compromised agent can't redirect future dials.
  advertisedHost?: string;
}

// The signed material returned to a calling-home agent.
export interface BootstrapCompletion {
  certPem: string;
  caPem: string;
}

// completeBootstrap completes a call-home bootstrap: signing (CSR crypto) first,
// then a single conditional UPDATE that re-validates the token and pins the result.
export async function completeBootstrap(
  call: BootstrapCallHome,
): Promise<BootstrapCompletion> {
  // Validate against the current servers (throws a typed BootstrapError on a bad
  // / expired / used token).
  const server = findServerForToken(await listAllServers(), call.token);
  // The cert SANs are the address WE will dial - the operator-declared host/ip
  // on the row, plus a self-reported host only if it matches (defence in depth).
  const dialHosts = [server.ip, server.host].filter(Boolean);
  const signed = await signBootstrapCsr(call.csrPem, dialHosts);
  const port =
    call.agentPort && call.agentPort > 0 ? call.agentPort : DEFAULT_AGENT_PORT;

  // Atomic consume + pin: the conditional UPDATE only fires while the token is
  // still unused, so concurrent call-homes can't both provision (the loser
  // updates 0 rows). `RETURNING id` tells us whether we won.
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

// observedTraefik is what a Hello actually OBSERVED about Traefik - `undefined`
// when it observed nothing. Kept here because that module is pure classification
// and must not import the data layer.
export function observedTraefik(hello: {
  dockerAvailable: boolean;
  traefikRunning: boolean;
}): boolean | undefined {
  return hello.dockerAvailable ? hello.traefikRunning : undefined;
}

// markServerSeen marks a server seen now: a best-effort write behind the live-read
// health check, never the source of truth for status. Callers pass traefikRunning
// through observedTraefik, never raw.
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
    // A CASE keeps the version pinned to "an agent exists" in one atomic UPDATE -
    // a NULL `agent_port` (unprovisioned) leaves the version NULL.
    if (agentVersion)
      set.agentVersion = sql`case when ${serversTable.agentPort} is not null then ${agentVersion} else ${serversTable.agentVersion} end`;
    if (typeof traefikRunning === "boolean")
      set.traefikEnabled = traefikRunning;
    // Born "" at registration and only known live; guard on non-empty so a
    // Docker-unreachable Hello never blanks a good value.
    if (dockerVersion) set.dockerVersion = dockerVersion;
    if (hostArch) set.hostArch = hostArch;
    // Guard on cpuCores>0 so a failed/empty measure never zeroes good values.
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
