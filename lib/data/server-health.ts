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
import { openAgent } from "../infra/agent-client/connect";
import { HEALTH_HELLO_TIMEOUT_MS } from "../infra/agent-client/deadlines";
import { AgentUnreachableError } from "../infra/agent-client/errors";
import { LINK_WAIT_MS } from "../infra/agent-link/protocol";
import {
  currentLink,
  hasLinked,
  linkMayCome,
  linksSettling,
  onAgentLink,
} from "../infra/agent-link/registry";
import {
  classifyServerHealth,
  HEALTH_MESSAGES,
  isRetryableProbeFailure,
  type ServerHealth,
} from "../infra/server-health";
import { requireInstanceAdmin } from "../membership";
import { dispatchServerAlert } from "../notify/dispatch";
import { nowIso } from "../ids";
import { instanceFrozen } from "./deplo-move/freeze";
import { markServerSeen, observedTraefik } from "./servers/agent-handshake";
import { getServerById, listAllServers } from "./servers/roster";
import type { HelloResponse } from "../agent/gen/agent";
import type { Server } from "../types/server";

const THROTTLE_MS = 15_000;
const FORCE_FLOOR_MS = 5_000;
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

  const observedAt = nowIso();

  const dialHello = async (): Promise<HelloResponse> => {
    // Ungated: health is about reachability, an unusable agent still answers.
    const conn = await openAgent(server.id);
    try {
      return await conn.hello(HEALTH_HELLO_TIMEOUT_MS);
    } finally {
      conn.close();
    }
  };

  const link = linkState(server);
  if (link) return probeOverLink(server, link, dialHello, observedAt);

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
  // Right after the panel starts, a server that closed its port once it linked is still relinking.
  if (error && linkMayCome(server.id, error)) return null;

  const health = classifyServerHealth(hello, error, {
    storageOnly: server.storageOnly,
  });
  if (error) {
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

// A server that links is never dialed: a missing link is offline, Hello over it says the rest (ADR-0040).
async function probeOverLink(
  server: Server,
  link: LinkState,
  askHello: () => Promise<HelloResponse>,
  observedAt: string,
): Promise<Server | null> {
  // Inside the grace the link may be on its way back; if not, its timer writes offline.
  if (link === "waiting") return null;
  let hello: HelloResponse | null = null;
  let health = LINK_OFFLINE;
  if (link === "linked") {
    try {
      hello = await withDeadline(askHello(), PROBE_DEADLINE_MS);
      health = classifyServerHealth(hello, null, {
        storageOnly: server.storageOnly,
      });
    } catch (e) {
      // Only a missing link means offline: a Hello lost on a live one settles nothing.
      if (e instanceof ProbeTimeout || e instanceof AgentUnreachableError)
        return null;
      console.error(`[deplo] health probe for ${server.name}: ${String(e)}`);
      health = classifyServerHealth(null, e);
    }
  }
  // No deploy guard: a build streams over the link, so none is running while it is gone.
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

const LINK_OFFLINE: ServerHealth = {
  status: "offline",
  message: HEALTH_MESSAGES.offline,
};

interface LinkWatch {
  off: (() => void) | null;
  graceMs: number;
  gone: Map<string, { since: number; timer: ReturnType<typeof setTimeout> }>;
}

// On globalThis like the registry it listens to: one subscription per process.
const WATCH_KEY = Symbol.for("deplo.server-health.link-watch");
const slot = globalThis as unknown as { [WATCH_KEY]?: LinkWatch };
const watch: LinkWatch = (slot[WATCH_KEY] ??= {
  off: null,
  graceMs: LINK_WAIT_MS,
  gone: new Map(),
});

/** A linked server's status follows its agent link (ADR-0040). Start it before the link door opens. */
export function startServerLinkStatus(opts: { graceMs?: number } = {}): void {
  if (watch.off) return;
  watch.graceMs = opts.graceMs ?? LINK_WAIT_MS;
  watch.off = onAgentLink((e) => {
    if (e.type === "down") return linkWentAway(e.serverId);
    void linkCameBack(e.serverId, e.hello);
  });
}

export function stopServerLinkStatus(): void {
  watch.off?.();
  watch.off = null;
  for (const { timer } of watch.gone.values()) clearTimeout(timer);
  watch.gone.clear();
}

type LinkState = "linked" | "waiting" | "offline";

/** How a server that links stands, read without a dial; null for one that never linked. */
function linkState(server: Server): LinkState | null {
  const serverId = server.id;
  const seen = hasLinked(serverId);
  if (!seen && !server.firstLinkedAt) return null;
  if (currentLink(serverId)) return "linked";
  // It linked before Deplo started: while links settle, it is on its way back (ADR-0041).
  if (!seen) return linksSettling() ? "waiting" : "offline";
  const gone = watch.gone.get(serverId);
  return gone && Date.now() - gone.since >= watch.graceMs
    ? "offline"
    : "waiting";
}

function linkWentAway(serverId: string): void {
  const timer = setTimeout(() => void linkStayedAway(serverId), watch.graceMs);
  timer.unref();
  watch.gone.set(serverId, { since: Date.now(), timer });
}

// Status writes are background work: none while a Deplo move has the instance frozen.
async function linkStayedAway(serverId: string): Promise<void> {
  const observedAt = nowIso();
  if (!hasLinked(serverId) || currentLink(serverId)) return;
  if (await instanceFrozen()) return;
  await recordServerHealth(serverId, LINK_OFFLINE, observedAt);
}

// The door's verifying Hello is the live Hello the probe would ask for.
async function linkCameBack(
  serverId: string,
  hello: HelloResponse,
): Promise<void> {
  clearTimeout(watch.gone.get(serverId)?.timer);
  watch.gone.delete(serverId);
  const observedAt = nowIso();
  if (await instanceFrozen()) return;
  const server = await getServerById(serverId).catch(() => null);
  if (!server) return;
  await recordServerHealth(
    serverId,
    classifyServerHealth(hello, null, { storageOnly: server.storageOnly }),
    observedAt,
  );
  await markServerSeen(serverId, hello.agentVersion, observedTraefik(hello));
}
