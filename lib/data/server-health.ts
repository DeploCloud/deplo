import "server-only";

import {
  and,
  type AnyColumn,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { getDb } from "../db/client";
import {
  deployments as deploymentsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { connectAgent, HEALTH_HELLO_TIMEOUT_MS } from "../infra/agent-client";
import {
  classifyServerHealth,
  isRetryableProbeFailure,
  type ServerHealth,
} from "../infra/server-health";
import { requireInstanceAdmin } from "../membership";
import { dispatchServerAlert } from "../notify/dispatch";
import { nowIso } from "../ids";
import {
  getServerById,
  listAllServers,
  markServerSeen,
  observedTraefik,
} from "./servers";
import type { HelloResponse } from "../agent/gen/agent";
import type { Server } from "../types";

/**
 * Live server health (Settings → Servers). The column stays a CACHE, never a gate
 * (ADR-0006).
 */

/** Skip re-dialing a server probed within this window (the ambient page-load sweep). */
const THROTTLE_MS = 15_000;
/**
 * The floor even a FORCED check (the operator's button) respects.
 */
const FORCE_FLOOR_MS = 5_000;
/**
 * Belt-and-braces bound around the WHOLE probe. The RPC has its own 3s deadline, but
 * that clock only starts once `connectAgent` has done a DB read and issued a client
 * cert - work that happens before gRPC is involved and is therefore outside it.
 */
const PROBE_DEADLINE_MS = 3_500;
/** Wait this long before the one confirming retry (see {@link probeServer}). */
const RETRY_DELAY_MS = 750;

/** Deployment states that prove the agent is alive right now. */
const ACTIVE_DEPLOY_STATES = ["queued", "building"] as const;

/**
 * In-flight probes, keyed by server id.
 */
const inFlight = new Map<string, Promise<Server | null>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a probe against a hard deadline. A rejection here means "we don't know". */
class ProbeTimeout extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProbeTimeout("health probe timed out")),
      ms,
    );
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * A server has a live agent worth dialing iff its cert pin is set to a NON-EMPTY
 * fingerprint.
 */
const HAS_LIVE_AGENT = and(
  isNotNull(serversTable.agentCertFingerprint),
  sql`${serversTable.agentCertFingerprint} <> ''`,
);

/**
 * CLAIM the right to probe a server, atomically, by advancing `status_probed_at` -
 * the throttle LEASE, deliberately NOT `status_checked_at`. The lease lives in its
 * own column so "we tried" and "we observed" never get conflated.
 */
export async function claimProbe(id: string, force: boolean): Promise<boolean> {
  const now = nowIso();
  const window = force ? FORCE_FLOOR_MS : THROTTLE_MS;
  const cutoff = new Date(Date.now() - window).toISOString();
  const stale = (col: AnyColumn) => or(isNull(col), sql`${col} < ${cutoff}`);
  const claimed = await getDb()
    .update(serversTable)
    .set({ statusProbedAt: now })
    .where(
      and(
        eq(serversTable.id, id),
        HAS_LIVE_AGENT,
        // No recent dial AND no recent observation - either one being fresh means a
        // re-dial would learn nothing new.
        stale(serversTable.statusProbedAt),
        stale(serversTable.statusCheckedAt),
      ),
    )
    .returning({ id: serversTable.id });
  return claimed.length > 0;
}

/** Server ids with a deployment running right now (their agent is provably alive). */
async function serversDeployingNow(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .selectDistinct({ serverId: deploymentsTable.serverId })
    .from(deploymentsTable)
    .where(
      and(
        inArray(deploymentsTable.serverId, ids),
        inArray(deploymentsTable.status, [...ACTIVE_DEPLOY_STATES]),
      ),
    );
  return new Set(
    rows.map((r) => r.serverId).filter((s): s is string => s !== null),
  );
}

/**
 * The ONE writer of an observed health outcome. Internal and UNGATED, like
 * `markServerSeen`: it is a heartbeat writer, not a user action, and gating it
 * would make it unusable from a future background sweeper.
 */
export async function recordServerHealth(
  id: string,
  health: ServerHealth,
  observedAt: string,
): Promise<void> {
  try {
    const written = await getDb()
      .update(serversTable)
      .set({
        status: health.status,
        statusMessage: health.message,
        statusCheckedAt: observedAt,
        // A successful probe IS a sighting; keep the P5 heartbeat in step with it.
        ...(health.status === "online" || health.status === "warning"
          ? { lastSeenAt: observedAt }
          : {}),
      })
      .where(
        and(
          eq(serversTable.id, id),
          // Same fence as the claim: never write health onto a row with no live agent.
          HAS_LIVE_AGENT,
          or(
            isNull(serversTable.statusCheckedAt),
            sql`${serversTable.statusCheckedAt} <= ${observedAt}`,
          ),
        ),
      )
      .returning({ name: serversTable.name });
    // Every caller that learns something about a server's health lands here, so this
    // one hook covers the prober, the metrics poll and all three supervisor writes.
    if (written.length > 0) alertServerHealth(id, written[0].name, health);
  } catch (e) {
    // Best-effort, like markServerSeen: a failed heartbeat write must never take
    // down the page that triggered it.
    console.error("[deplo] recordServerHealth failed:", e);
  }
}

/**
 * The four health verdicts map one-to-one onto four alerts.
 */
function alertServerHealth(
  id: string,
  name: string,
  health: ServerHealth,
): void {
  // `provisioning` is a server mid-setup, not an observed verdict - nothing to
  // report until it has actually answered once.
  if (health.status === "provisioning") return;
  const dedupe = { id: `server:${id}`, state: health.status };
  const alert = {
    online: {
      key: "server_online" as const,
      title: `${name} is back online`,
      body: "Deplo can reach it again.",
    },
    warning: {
      key: "server_unmanageable" as const,
      title: `${name} cannot run apps`,
      body:
        health.message ||
        "Deplo reached the server but not its container runtime.",
    },
    offline: {
      key: "server_offline" as const,
      title: `${name} is offline`,
      body: health.message || "The server stopped answering.",
    },
    error: {
      key: "server_trust_changed" as const,
      title: `${name} was refused`,
      body:
        health.message ||
        "The server did not present the identity Deplo trusts.",
    },
  }[health.status];
  dispatchServerAlert(id, { ...alert, dedupe, path: "/settings/servers" });
}

/**
 * Dial one server's agent and persist what we learn. A transport failure gets one
 * more chance after 750ms before we demote the server.
 */
async function probeServer(
  server: Server,
  force: boolean,
): Promise<Server | null> {
  if (!(await claimProbe(server.id, force))) return null;

  // Watermark on probe START, not on write. See recordServerHealth.
  const observedAt = nowIso();

  const dialHello = async (): Promise<HelloResponse> => {
    const conn = await connectAgent(server.id);
    try {
      return await conn.hello(HEALTH_HELLO_TIMEOUT_MS);
    } finally {
      conn.close();
    }
  };

  let hello: HelloResponse | null = null;
  let error: unknown = null;
  try {
    hello = await withDeadline(dialHello(), PROBE_DEADLINE_MS);
  } catch (e) {
    if (e instanceof ProbeTimeout) {
      console.error(
        `[deplo] health probe for ${server.name} timed out; leaving status as-is`,
      );
      return null;
    }
    if (isRetryableProbeFailure(e)) {
      await sleep(RETRY_DELAY_MS);
      try {
        hello = await withDeadline(dialHello(), PROBE_DEADLINE_MS);
      } catch (retryErr) {
        if (retryErr instanceof ProbeTimeout) return null;
        error = retryErr;
      }
    } else {
      error = e;
    }
  }

  const health = classifyServerHealth(hello, error, {
    storageOnly: server.storageOnly,
  });
  if (error) {
    // The curated message goes in the column; the raw one, which carries the pinned
    // fingerprint, the dial address and the gRPC detail - goes here and nowhere else.
    console.error(`[deplo] health probe for ${server.name}: ${String(error)}`);
  }

  // Never demote a server that is running a deployment RIGHT NOW.
  if (
    health.status === "offline" &&
    (await serversDeployingNow([server.id])).has(server.id)
  ) {
    console.error(
      `[deplo] health probe for ${server.name} failed while it is deploying; not demoting`,
    );
    return null;
  }

  await recordServerHealth(server.id, health, observedAt);
  // This Hello carries `traefikRunning` too, and the prober is the ONLY thing that
  // dials a server on a schedule, so before this, the Traefik badge could only ever
  // be refreshed by a deploy pre-flight or the monitoring stream, and a host nobody
  if (hello)
    await markServerSeen(server.id, hello.agentVersion, observedTraefik(hello));
  return getServerById(server.id);
}

/**
 * Probe a server, coalescing concurrent callers onto one dial. Returns the stored row
 * unchanged when the probe was throttled or inconclusive, never null-as-in-unknown, so
 * a caller always has something to render.
 */
async function probeCoalesced(server: Server, force: boolean): Promise<Server> {
  const existing = inFlight.get(server.id);
  if (existing) return (await existing) ?? server;

  const run = probeServer(server, force).catch((e) => {
    console.error(`[deplo] health probe for ${server.name} failed:`, e);
    return null;
  });
  inFlight.set(server.id, run);
  try {
    return (await run) ?? server;
  } finally {
    inFlight.delete(server.id);
  }
}

/** A server with no agent yet is never dialed - there is nothing on the other end. */
function isProbeable(server: Server): boolean {
  return Boolean(server.agent?.certFingerprint);
}

/**
 * Re-check ONE server's health (the per-card button). The gate lives HERE, in the
 * data layer - the GraphQL `authScopes` is the introspectable contract, this is
 * the boundary.
 */
export async function checkServerHealth(
  id: string,
  opts: { force?: boolean } = {},
): Promise<Server> {
  await requireInstanceAdmin();
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  if (!isProbeable(server)) return server;
  return probeCoalesced(server, opts.force ?? false);
}

/**
 * Re-check EVERY server (the page's on-load sweep, and the header's "Check all").
 */
export async function checkAllServerHealth(
  opts: { force?: boolean } = {},
): Promise<Server[]> {
  await requireInstanceAdmin();
  const servers = await listAllServers();
  return Promise.all(
    servers.map((s) =>
      isProbeable(s) ? probeCoalesced(s, opts.force ?? false) : s,
    ),
  );
}
