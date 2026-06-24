import "server-only";

import { listAllServers, getServerById } from "./servers";
import { assertUser } from "../auth";
import { hostFacts } from "../infra/host";
import { connectAgent } from "../infra/agent-client";
import { markServerSeen } from "./servers";
import { isAgentOutdated, reportedAgentVersion, resolveExpectedAgentVersion } from "../version";
import type { Server } from "../types";

/**
 * Real server metrics. EVERY server — including the host running Deplo — is
 * measured by its agent's Metrics RPC over mTLS (PLAN Part C): the agent measures
 * its own host (CPU/mem/disk + a live running-container count). An unreachable /
 * not-yet-provisioned agent reports no live data (online:false) rather than
 * fabricating any.
 */
export interface ServerMetrics {
  serverId: string;
  online: boolean;
  /**
   * Whether a Traefik reverse proxy is running on the server (read live from the
   * agent's Hello on this same poll). Carried in the live payload so the Traefik
   * badge updates without a page reload, like online/CPU — and self-corrects when
   * Traefik is added/removed. False when offline/unreachable.
   */
  traefik: boolean;
  cpu: number;
  cpuCores: number;
  memUsed: number;
  memTotal: number;
  memPct: number;
  diskUsed: number;
  diskTotal: number;
  diskPct: number;
  netRx: number;
  netTx: number;
  load: [number, number, number];
  uptimeSec: number;
  containers: number;
  /**
   * The agent version this server is running, as last reported (refreshed on this
   * same poll's Hello). Null until the agent has called home. Carried in the live
   * payload so the version badge — and the outdated check below — update without a
   * page reload: when an operator clicks "Check for updates" and a newer release
   * exists, the next poll (~1s) flips every open Servers tab's badge to outdated.
   */
  agentVersion: string | null;
  /**
   * The agent version every server should be running — the latest GitHub release,
   * resolved once per poll and stamped onto every server's snapshot. Carried live
   * so a freshly-resolved "latest" (after a "Check for updates" bust) reaches the
   * badges through the poll, not just a page refresh.
   */
  expectedAgentVersion: string;
  /** True when agentVersion is strictly behind expectedAgentVersion (live). */
  agentOutdated: boolean;
  ts: number;
}

/**
 * The live agent-version triple stamped onto every snapshot. `server` may be
 * absent (a server we couldn't even look up) — then the version is unknown and,
 * per isAgentOutdated, never flagged outdated.
 */
function agentVersionFields(
  expected: string,
  server?: Server,
): Pick<ServerMetrics, "agentVersion" | "expectedAgentVersion" | "agentOutdated"> {
  const agentVersion = server ? reportedAgentVersion(server) : null;
  return {
    agentVersion,
    expectedAgentVersion: expected,
    agentOutdated: isAgentOutdated(agentVersion, expected),
  };
}

function unavailable(serverId: string, expected: string, server?: Server): ServerMetrics {
  const facts = hostFacts();
  return {
    serverId,
    online: false,
    traefik: false,
    cpu: 0,
    cpuCores: facts.cpuCores,
    memUsed: 0,
    memTotal: 0,
    memPct: 0,
    diskUsed: 0,
    diskTotal: 0,
    diskPct: 0,
    netRx: 0,
    netTx: 0,
    load: [0, 0, 0],
    uptimeSec: 0,
    containers: 0,
    ...agentVersionFields(expected, server),
    ts: Date.now(),
  };
}

/**
 * Measure a remote server via its agent's Metrics RPC. The agent measures its own
 * host (CPU/mem/disk of its --data-dir + a live running-container count) and
 * returns a HostMetrics, mapped 1:1 into ServerMetrics. An unreachable / not-yet-
 * provisioned agent reports no live data (online:false) — never fabricated, never
 * the control plane's own numbers.
 *
 * NOTE: the dashboard polls every ~1s, so this dials+closes a gRPC client per
 * poll per viewer. Acceptable at current scale; a connection pool is a Part C+
 * optimisation (TODO) if the fleet/viewer count makes the churn matter.
 */
async function measureRemote(server: Server, expected: string): Promise<ServerMetrics> {
  const conn = await connectAgent(server.id);
  try {
    // Empty dataDir => the agent measures its own configured --data-dir.
    const m = await conn.metrics("");
    // Read the Traefik state live on this same poll (the poll already holds the
    // mTLS connection open). This is the ONLY steady-state path — the deploy
    // preflight aside — so without it traefikEnabled would only ever update on a
    // deploy. Best-effort: a Hello failure doesn't fail the metrics snapshot;
    // we just keep the last-known traefik flag for the payload.
    let traefik = server.traefikEnabled;
    // The agent version reported on THIS poll's Hello (if it succeeds). Used for
    // the live outdated check so a just-updated agent self-corrects in the same
    // snapshot, rather than carrying the pre-poll stored value.
    let liveAgentVersion: string | null = reportedAgentVersion(server);
    try {
      const hello = await conn.hello();
      traefik = hello.traefikRunning;
      if (hello.agentVersion) liveAgentVersion = hello.agentVersion;
      // Persist the live value (read-live-not-stored, like health). The badge's
      // server-rendered render reads this on the next page load; the live payload
      // below updates it without a reload.
      await markServerSeen(server.id, hello.agentVersion, hello.traefikRunning);
    } catch {
      /* metrics succeeded; the Hello refresh is best-effort */
    }
    return {
      serverId: server.id,
      online: true,
      traefik,
      cpu: m.cpu,
      cpuCores: m.cpuCores,
      memUsed: Number(m.memUsed),
      memTotal: Number(m.memTotal),
      memPct: m.memPct,
      diskUsed: Number(m.diskUsed),
      diskTotal: Number(m.diskTotal),
      diskPct: m.diskPct,
      netRx: Number(m.netRx),
      netTx: Number(m.netTx),
      load: [m.load1, m.load5, m.load15],
      uptimeSec: Number(m.uptimeSec),
      containers: m.runningContainers,
      agentVersion: liveAgentVersion,
      expectedAgentVersion: expected,
      agentOutdated: isAgentOutdated(liveAgentVersion, expected),
      ts: Date.now(),
    };
  } finally {
    conn.close();
  }
}

async function metricsFor(server: Server, expected: string): Promise<ServerMetrics> {
  try {
    return await measureRemote(server, expected);
  } catch {
    // Unreachable / unprovisioned agent, or any transport error: report offline
    // rather than a fabricated snapshot. Still carry the version fields from the
    // stored value so an offline-but-outdated server stays flagged.
    return unavailable(server.id, expected, server);
  }
}

export async function getServerMetrics(serverId: string): Promise<ServerMetrics> {
  await assertUser();
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");
  return metricsFor(server, await resolveExpectedAgentVersion());
}

export async function getAllServerMetrics(): Promise<ServerMetrics[]> {
  await assertUser();
  // Resolve "latest" once per poll (memoised) and stamp it onto every snapshot —
  // a "Check for updates" bust resolved a fresh value, so this poll carries it to
  // every open Servers tab's badge.
  const expected = await resolveExpectedAgentVersion();
  return Promise.all((await listAllServers()).map((s) => metricsFor(s, expected)));
}

/**
 * Cheap, instant metrics for the initial server render. measureLocal() takes
 * ~1.2s (a 1s network-delta window + a 200ms CPU sample + docker calls), which
 * would block the Monitoring and Servers pages on every load. The client polls
 * the real metrics every second (see ServerMetricsProvider), so the server only
 * needs to supply a sensible hydration fallback: each server's last-known usage
 * from the store. No sampling, no docker, no sleep — the live values arrive on
 * the first client poll and replace these within ~1s.
 */
export async function getInitialServerMetrics(): Promise<ServerMetrics[]> {
  await assertUser();
  const facts = hostFacts();
  const expected = await resolveExpectedAgentVersion();
  return (await listAllServers()).map((s) => ({
    serverId: s.id,
    // Cheap hydration hint from the stored status; the first live poll replaces
    // it. A not-yet-provisioned server has no agent and reports offline, exactly
    // as metricsFor() would, keeping the card UI consistent.
    online: Boolean(s.agent?.certFingerprint) && s.status === "online",
    // Cheap hydration value from the stored flag; the first live poll replaces it.
    traefik: s.traefikEnabled,
    cpu: s.cpuUsage,
    cpuCores: s.cpuCores || facts.cpuCores,
    memUsed: 0,
    memTotal: s.memoryMb * 1024 * 1024,
    memPct: s.memoryUsage,
    diskUsed: 0,
    diskTotal: s.diskGb * 1024 * 1024 * 1024,
    diskPct: s.diskUsage,
    netRx: 0,
    netTx: 0,
    load: [0, 0, 0],
    uptimeSec: 0,
    containers: 0,
    // Stored version + the resolved "latest" — keeps the hydration badge identical
    // to what the RSC card renders, so the first poll doesn't visibly flip it.
    ...agentVersionFields(expected, s),
    ts: Date.now(),
  }));
}
