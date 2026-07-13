import "server-only";

import { and, type AnyColumn, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

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
import { nowIso } from "../ids";
import { getServerById, listAllServers } from "./servers";
import type { HelloResponse } from "../agent/gen/agent";
import type { Server } from "../types";

/**
 * Live server health (Settings → Servers).
 *
 * `servers.status` used to be write-once — `provisioning` at registration, `online`
 * the moment the agent called home, and never revisited — so a server whose agent
 * had been dead for a month still rendered a confident green "Online". This module
 * makes the column an OBSERVATION instead of a claim: a probe dials the agent's
 * `Hello` over the existing pinned-mTLS channel, `classifyServerHealth` turns the
 * outcome into a status + a curated reason, and both are persisted alongside
 * `status_checked_at` — the timestamp that lets the UI say "Online, checked 12s ago"
 * and refuse to paint a stale value at all.
 *
 * The column stays a CACHE, never a gate (ADR-0006). Nothing in the deploy path reads
 * it; a server marked `offline` here is still deployable the instant its agent answers
 * the mandatory live Hello pre-flight. Writing a wrong status must never be able to
 * cause an outage — which is also why every "we don't know" outcome writes nothing at
 * all rather than guessing.
 */

/** Skip re-dialing a server probed within this window (the ambient page-load sweep). */
const THROTTLE_MS = 15_000;
/**
 * The floor even a FORCED check (the operator's button) respects. "Force" means
 * "ignore the ambient throttle", not "dial as fast as you can click" — this is the
 * only backstop against a mashed button (or a scripted bearer-token caller) turning
 * the control plane into a fan-out dialer.
 */
const FORCE_FLOOR_MS = 5_000;
/**
 * Belt-and-braces bound around the WHOLE probe. The RPC has its own 3s deadline, but
 * that clock only starts once `connectAgent` has done a DB read and issued a client
 * cert — work that happens before gRPC is involved and is therefore outside it.
 */
const PROBE_DEADLINE_MS = 3_500;
/** Wait this long before the one confirming retry (see {@link probeServer}). */
const RETRY_DELAY_MS = 750;

/** Deployment states that prove the agent is alive right now. */
const ACTIVE_DEPLOY_STATES = ["queued", "building"] as const;

/**
 * In-flight probes, keyed by server id. A dedupe, NOT a cache: five admin tabs that
 * land in the same 200ms share one dial instead of five. Purely an optimisation —
 * it has no correctness role (the DB throttle claim below is the real serialization),
 * so it is safe that it is per-process and evaporates on restart.
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
    timer = setTimeout(() => reject(new ProbeTimeout("health probe timed out")), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * A server has a live agent worth dialing iff its cert pin is set to a NON-EMPTY
 * fingerprint. `removeServer` revokes trust by writing `""` (not NULL) and the
 * partial unique index guards `is not null and <> ''` — so the empty string is a
 * real second sentinel, and a probe must treat a trust-revoked row exactly like a
 * never-provisioned one. Both branches of the prober fence on this.
 */
const HAS_LIVE_AGENT = and(
  isNotNull(serversTable.agentCertFingerprint),
  sql`${serversTable.agentCertFingerprint} <> ''`,
);

/**
 * CLAIM the right to probe a server, atomically, by advancing `status_probed_at` — the
 * throttle LEASE, deliberately NOT `status_checked_at`.
 *
 * Using the freshness column as the lease was a real bug: an inconclusive probe (a
 * timeout, a deploy-in-flight skip) claims the lease but records nothing, and if the
 * lease WERE `status_checked_at` the row would then wear a fresh timestamp over a stale
 * status — a confident green painted for a host nobody reached. The lease lives in its
 * own column so "we tried" and "we observed" never get conflated.
 *
 * A conditional UPDATE rather than read-then-decide because the point is concurrency: N
 * page-loads hitting a dead host must produce ONE dial. Whoever wins the UPDATE dials;
 * everyone else gets 0 rows and reuses the stored observation. The claim also skips when
 * a genuine observation is already fresh (`status_checked_at` recent) — no reason to
 * re-dial a server the 1s metrics poll just measured.
 *
 * {@link HAS_LIVE_AGENT} is the fence that keeps a `provisioning` (or trust-revoked)
 * server out of the prober entirely: `resolveTarget` throws for those from a pure DB
 * read, which would misclassify every server awaiting its first call-home as `offline`.
 *
 * Exported only so the throttle can be tested without a socket — not part of the
 * module's interface; nothing outside lib/data/server-health.test.ts calls it.
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
        // No recent dial AND no recent observation — either one being fresh means a
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
  return new Set(rows.map((r) => r.serverId).filter((s): s is string => s !== null));
}

/**
 * The ONE writer of an observed health outcome. Everything that learns something about
 * a server's health — the prober here, and the metrics poll in lib/data/monitoring.ts —
 * goes through this, so the dashboard can never show live green while the column says
 * offline. Internal and UNGATED, like `markServerSeen`: it is a heartbeat writer, not a
 * user action, and gating it would make it unusable from a future background sweeper.
 *
 * `observedAt` is the time the probe STARTED, and the write is watermarked on it. Probes
 * do not finish in the order they start: a 3s "offline" probe launched first can land
 * after a 50ms "online" probe launched second, and a naive last-write-wins would leave
 * the row claiming an outage that a later observation already disproved.
 */
export async function recordServerHealth(
  id: string,
  health: ServerHealth,
  observedAt: string,
): Promise<void> {
  try {
    await getDb()
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
      );
  } catch (e) {
    // Best-effort, like markServerSeen: a failed heartbeat write must never take
    // down the page that triggered it.
    console.error("[deplo] recordServerHealth failed:", e);
  }
}

/**
 * Dial one server's agent and persist what we learn. Returns the refreshed row, or the
 * stored row unchanged when the probe was throttled or could not be completed.
 *
 * Two things here exist purely to avoid lying:
 *
 *  - the CONFIRMING RETRY. A transport failure gets one more chance after 750ms before
 *    we demote the server. An agent that is re-exec'ing mid self-update, or a single
 *    dropped packet on a WAN link, is not an outage — and because the outcome is
 *    PERSISTED and the throttle then suppresses re-checks for 15s, a false `offline`
 *    would sit on the operator's screen long after the blip is over.
 *  - the WRAPPER TIMEOUT writing NOTHING. If we could not complete the probe, we do not
 *    know the status; "don't know" is not "offline". The row keeps its previous
 *    observation and its previous timestamp, so the UI ages it out to "Unknown" on its
 *    own rather than being handed a fresh, fabricated verdict.
 */
async function probeServer(server: Server, force: boolean): Promise<Server | null> {
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
      console.error(`[deplo] health probe for ${server.name} timed out; leaving status as-is`);
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

  const health = classifyServerHealth(hello, error);
  if (error) {
    // The curated message goes in the column; the raw one — which carries the pinned
    // fingerprint, the dial address and the gRPC detail — goes here and nowhere else.
    console.error(`[deplo] health probe for ${server.name}: ${String(error)}`);
  }

  // Never demote a server that is running a deployment RIGHT NOW. Its agent is
  // provably alive (it is streaming build events to us); a Hello that lost a race with
  // a build-pegged host is a false negative, and persisting it would tell the operator
  // their server is down in the middle of a deploy that is visibly working.
  if (health.status === "offline" && (await serversDeployingNow([server.id])).has(server.id)) {
    console.error(
      `[deplo] health probe for ${server.name} failed while it is deploying; not demoting`,
    );
    return null;
  }

  await recordServerHealth(server.id, health, observedAt);
  return getServerById(server.id);
}

/**
 * Probe a server, coalescing concurrent callers onto one dial. Returns the stored row
 * unchanged when the probe was throttled or inconclusive — never null-as-in-unknown, so
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

/** A server with no agent yet is never dialed — there is nothing on the other end. */
function isProbeable(server: Server): boolean {
  return Boolean(server.agent?.certFingerprint);
}

/**
 * Re-check ONE server's health (the per-card button). Instance-admin only: servers are
 * instance-wide infra, and every other server mutation gates the same way. The gate
 * lives HERE, in the data layer — the GraphQL `authScopes` is the introspectable
 * contract, this is the boundary.
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
 * Unprovisioned servers pass through untouched.
 *
 * Fan-out is bounded by the throttle claim, not by a pool: a claim is one round-trip to
 * Postgres and losers never dial, so the real concurrency is "servers whose 15s window
 * has elapsed" — and the deployment this runs on manages a handful of hosts, not a fleet
 * of hundreds. If that stops being true, bound it here, not in the caller.
 */
export async function checkAllServerHealth(
  opts: { force?: boolean } = {},
): Promise<Server[]> {
  await requireInstanceAdmin();
  const servers = await listAllServers();
  return Promise.all(
    servers.map((s) => (isProbeable(s) ? probeCoalesced(s, opts.force ?? false) : s)),
  );
}
