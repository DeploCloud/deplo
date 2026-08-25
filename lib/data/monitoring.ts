import "server-only";

import { listServersForCurrentTeam, getServer } from "./servers";
import { hasCapability, requireCapability } from "../membership";
import { hostFacts } from "../infra/host";
import { connectAgent } from "../infra/agent-client";
import { markServerSeen, observedTraefik } from "./servers";
import { recordServerHealth } from "./server-health";
import { classifyServerHealth } from "../infra/server-health";
import { reportedAgentVersion, resolveExpectedAgentVersion } from "../version";
import { nowIso } from "../ids";
import { getMetricsHistory, recordMetricsSample } from "../monitoring/history";
import { isMetricsSavingEnabled } from "./monitoring-settings";
import type { Server } from "../types";

/**
 * Real server metrics.
 */
export interface ServerMetrics {
  serverId: string;
  online: boolean;
  /**
   * Whether a Traefik reverse proxy is running on the server (read live from the
   * agent's Hello on this same poll).
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
   * same poll's Hello).
   */
  agentVersion: string | null;
  /**
   * The agent version every server should be running — the latest GitHub release,
   * resolved once per poll and stamped onto every server's snapshot.
   */
  expectedAgentVersion: string;
  ts: number;
}

/**
 * The live agent-version pair stamped onto every snapshot. `server` may be
 * absent (a server we couldn't even look up) — then the version is unknown.
 */
function agentVersionFields(
  expected: string,
  server?: Server,
): Pick<ServerMetrics, "agentVersion" | "expectedAgentVersion"> {
  const agentVersion = server ? reportedAgentVersion(server) : null;
  return { agentVersion, expectedAgentVersion: expected };
}

function unavailable(
  serverId: string,
  expected: string,
  server?: Server,
): ServerMetrics {
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
 * Measure a remote server via its agent's Metrics RPC. An unreachable / not-yet-
 * provisioned agent reports no live data (online:false) — never fabricated, never
 * the control plane's own numbers.
 */
async function measureRemote(
  server: Server,
  expected: string,
): Promise<ServerMetrics> {
  // Watermark for any health we learn on this poll — see recordServerHealth.
  const observedAt = nowIso();
  const conn = await connectAgent(server.id);
  try {
    // Empty dataDir => the agent measures its own configured --data-dir.
    const m = await conn.metrics("");
    // Read the Traefik state live on this same poll (the poll already holds the mTLS
    // connection open). This is the ONLY steady-state path — the deploy preflight aside
    // — so without it traefikEnabled would only ever update on a deploy.
    let traefik = server.traefikEnabled;
    // The agent version reported on THIS poll's Hello (if it succeeds). Used for
    // the live outdated check so a just-updated agent self-corrects in the same
    // snapshot, rather than carrying the pre-poll stored value.
    let liveAgentVersion: string | null = reportedAgentVersion(server);
    try {
      const hello = await conn.hello();
      // `?? traefik` keeps the last-known flag when the Hello observed nothing (Docker
      // unreachable) — see observedTraefik. Same reason the catch below keeps it.
      traefik = observedTraefik(hello) ?? traefik;
      if (hello.agentVersion) liveAgentVersion = hello.agentVersion;
      // Persist the live value (read-live-not-stored, like health).
      await markServerSeen(
        server.id,
        hello.agentVersion,
        observedTraefik(hello),
        {
          cpuCores: m.cpuCores,
          memoryMb: Math.round(Number(m.memTotal) / (1024 * 1024)),
          diskGb: Math.round(Number(m.diskTotal) / (1024 * 1024 * 1024)),
        },
        hello.dockerVersion,
        hello.hostArch,
      );
      // This Hello is a health OBSERVATION as good as the Servers page's own probe, so it
      // goes through the SAME recorder.
      await recordServerHealth(
        server.id,
        classifyServerHealth(hello, null, { storageOnly: server.storageOnly }),
        observedAt,
      );
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
      ts: Date.now(),
    };
  } finally {
    conn.close();
  }
}

async function metricsFor(
  server: Server,
  expected: string,
): Promise<ServerMetrics> {
  try {
    return await measureRemote(server, expected);
  } catch {
    // Unreachable / unprovisioned agent, or any transport error: report offline rather
    // than a fabricated snapshot.
    return unavailable(server.id, expected, server);
  }
}

export async function getServerMetrics(
  serverId: string,
): Promise<ServerMetrics> {
  // `view_metrics` is what the permission catalog promises ("see live and
  // historical usage"), enforced here and not only in the resolver.
  await requireCapability("view_metrics");
  // Team-scoped: getServer returns null for a server this team can't target, so
  // a member can't poll the live metrics of a server restricted to other teams.
  const server = await getServer(serverId);
  if (!server) throw new Error("Server not found");
  const m = await metricsFor(server, await resolveExpectedAgentVersion());
  // Every live poll doubles as a history writer (when saving is on): a watched
  // server gets 1s-dense history for free, and the background collector sees the
  // fresh sample and skips it. recordMetricsSample refuses offline snapshots.
  if (await isMetricsSavingEnabled()) recordMetricsSample(m);
  return m;
}

/**
 * The buffered metrics HISTORY for one server (lib/monitoring/history.ts) — what
 * the Monitoring page seeds its charts from on load, so a reload no longer starts
 * them empty.
 */
export async function getServerMetricsHistory(
  serverId: string,
): Promise<ServerMetrics[]> {
  // Soft (empty) rather than a throw: this one seeds a chart on page load.
  if (!(await hasCapability("view_metrics"))) return [];
  const server = await getServer(serverId);
  if (!server) throw new Error("Server not found");
  return getMetricsHistory(serverId);
}

/**
 * Session-free measure for the background collector (lib/monitoring/collector.ts),
 * which has no request context to team-scope against: it takes an already-resolved
 * Server row — never a caller-supplied id — and its result reaches no client
 */
export const measureServerForCollector = metricsFor;

/**
 * Cheap, instant metrics for the initial server render. measureLocal() takes ~1.2s
 * (a 1s network-delta window + a 200ms CPU sample + docker calls), which would
 * block the Monitoring and Servers pages on every load.
 */
/** Race a promise against a short deadline; rejects if it doesn't settle in time. */
function withSpecTimeout<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("spec measure timed out")), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * Fill in each server's hardware specs (cores / RAM / disk) for a STATIC render —
 * the Servers page shows capacity without polling.
 */
export async function hydrateServerSpecs(servers: Server[]): Promise<Server[]> {
  // A migration source is never measured: this dial happens INSIDE the page render,
  // so a freshly registered one (specs still 0, which it always is - it is never
  // polled) would put a multi-second round trip to another platform's box in front of
  const measurable = (s: Server) =>
    s.cpuCores === 0 && Boolean(s.agent?.certFingerprint) && !s.importOnly;
  if (!servers.some(measurable)) return servers;
  const expected = await resolveExpectedAgentVersion();
  return Promise.all(
    servers.map(async (s) => {
      if (!measurable(s)) return s;
      try {
        // Bound the one-time measure: this runs SYNCHRONOUSLY in the page render, so an
        // unreachable provisioned host must degrade to "—" in a few seconds rather than
        // holding SSR for the full 30s metrics deadline.
        const m = await withSpecTimeout(measureRemote(s, expected));
        if (m.cpuCores <= 0) return s;
        return {
          ...s,
          cpuCores: m.cpuCores,
          memoryMb: Math.round(m.memTotal / (1024 * 1024)),
          diskGb: Math.round(m.diskTotal / (1024 * 1024 * 1024)),
          traefikEnabled: m.traefik,
        };
      } catch {
        return s;
      }
    }),
  );
}

export async function getInitialServerMetrics(): Promise<ServerMetrics[]> {
  if (!(await hasCapability("view_metrics"))) return [];
  const facts = hostFacts();
  const expected = await resolveExpectedAgentVersion();
  // A migration source is out: it is another platform's machine, borrowed to read
  // volumes from, and no telemetry stream is opened to it in the first place - a
  // card for it would sit permanently blank and count as fleet capacity.
  return (await listServersForCurrentTeam())
    .filter((s) => !s.importOnly)
    .map((s) => ({
      serverId: s.id,
      // Cheap hydration hint from the stored status; the first live poll replaces it. A
      // not-yet-provisioned server has no agent and reports offline, exactly as
      // metricsFor() would, keeping the card UI consistent.
      online:
        Boolean(s.agent?.certFingerprint) &&
        (s.status === "online" || s.status === "warning"),
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
