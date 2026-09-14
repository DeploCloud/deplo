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
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { connectAgent } from "../infra/agent-client/connect";
import { HEALTH_HELLO_TIMEOUT_MS } from "../infra/agent-client/deadlines";
import {
  classifyServerHealth,
  isRetryableProbeFailure,
  type ServerHealth,
} from "../infra/server-health";
import { requireInstanceAdmin } from "../membership";
import { dispatchServerAlert } from "../notify/dispatch";
import { nowIso } from "../ids";
import { markServerSeen, observedTraefik } from "./servers/agent-handshake";
import { getServerById, listAllServers } from "./servers/roster";
import type { HelloResponse } from "../agent/gen/agent";
import type { Server } from "../types/server";

// The status column stays a CACHE, never a gate (ADR-0006).

const THROTTLE_MS = 15_000;
const FORCE_FLOOR_MS = 5_000;
// Bounds the WHOLE probe: connectAgent reads the DB and issues a cert before the RPC's own 3s clock starts.
const PROBE_DEADLINE_MS = 3_500;
const RETRY_DELAY_MS = 750;

const ACTIVE_DEPLOY_STATES = ["queued", "building"] as const;

const inFlight = new Map<string, Promise<Server | null>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

const HAS_LIVE_AGENT = and(
  isNotNull(serversTable.agentCertFingerprint),
  sql`${serversTable.agentCertFingerprint} <> ''`,
);

// claimProbe - the throttle LEASE: `status_probed_at` records "we tried", never "we observed".
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
        // Either column being fresh means a re-dial would learn nothing new.
        stale(serversTable.statusProbedAt),
        stale(serversTable.statusCheckedAt),
      ),
    )
    .returning({ id: serversTable.id });
  return claimed.length > 0;
}

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

// recordServerHealth - the one writer of an observed outcome; ungated, because it is a heartbeat, not a user action.
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
        ...(health.status === "online" || health.status === "warning"
          ? { lastSeenAt: observedAt }
          : {}),
      })
      .where(
        and(
          eq(serversTable.id, id),
          HAS_LIVE_AGENT,
          or(
            isNull(serversTable.statusCheckedAt),
            sql`${serversTable.statusCheckedAt} <= ${observedAt}`,
          ),
        ),
      )
      .returning({ name: serversTable.name });
    if (written.length > 0) alertServerHealth(id, written[0].name, health);
  } catch (e) {
    console.error("[deplo] recordServerHealth failed:", e);
  }
}

function alertServerHealth(
  id: string,
  name: string,
  health: ServerHealth,
): void {
  // `provisioning` is mid-setup, not an observed verdict - nothing to report yet.
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
    // The raw error carries the pinned fingerprint and the dial address: log it, never store it.
    console.error(`[deplo] health probe for ${server.name}: ${String(error)}`);
  }

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
  if (hello)
    await markServerSeen(server.id, hello.agentVersion, observedTraefik(hello));
  return getServerById(server.id);
}

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

function isProbeable(server: Server): boolean {
  return Boolean(server.agent?.certFingerprint);
}

// checkServerHealth - re-check ONE server (the per-card button); this gate is the boundary.
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

// checkAllServerHealth - re-check every server (the on-load sweep and "Check all").
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
