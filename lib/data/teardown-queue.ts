import "server-only";

import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { pendingTeardowns } from "../db/schema/control-plane/deployments";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { newId, nowIso } from "../ids";
import { connectAgent } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { dispatchServerAlert } from "../notify/dispatch";
import { mapLimit } from "../utils";
import { recordActivity } from "./activity";

// ponytail: the verdict covers containers, not volumes - no agent RPC lists

export interface TeardownEntry {
  serverId: string;
  deployKey: string;
  projectLabel: string;
  label: string;
  teamId: string | null;
  reclaimVolumes?: string[];
}

const BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  24 * 60 * 60_000,
];

export const MAX_TEARDOWN_ATTEMPTS = 8;

const DRAIN_BATCH = 8;

const DRAIN_CONCURRENCY = 4;

const INLINE_GRACE_MS = 4 * 60_000;

const REOPEN_AFTER_MS = 60 * 60_000;

const SEEN_RECENTLY_MS = 5 * 60_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type TeardownAgent = Pick<
  AgentConnection,
  "destroyStack" | "listInstances" | "stopStack" | "close"
>;

let dial: (serverId: string) => Promise<TeardownAgent> = connectAgent;

export function __setTeardownDialForTest(
  fn: ((serverId: string) => Promise<TeardownAgent>) | null,
): void {
  dial = fn ?? connectAgent;
}

export function nextTeardownAttempt(
  attempts: number,
  now: Date,
): { giveUp: true } | { giveUp: false; at: string } {
  if (attempts >= MAX_TEARDOWN_ATTEMPTS) return { giveUp: true };
  const step =
    BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
  return { giveUp: false, at: new Date(now.getTime() + step).toISOString() };
}

export async function enqueueTeardowns(
  entries: TeardownEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const now = nowIso();
  const firstDrain = new Date(Date.now() + INLINE_GRACE_MS).toISOString();
  try {
    await getDb()
      .insert(pendingTeardowns)
      .values(
        entries.map((e) => ({
          id: newId("tdn"),
          serverId: e.serverId,
          deployKey: e.deployKey,
          projectLabel: e.projectLabel,
          label: e.label,
          teamId: e.teamId,
          attempts: 0,
          lastError: "",
          nextAttemptAt: firstDrain,
          abandonedAt: null,
          createdAt: now,
        })),
      )
      .onConflictDoNothing();
  } catch (e) {
    console.error("[deplo] could not queue a teardown:", errMsg(e));
  }
}

async function stackContainers(
  conn: TeardownAgent,
  entry: Pick<TeardownEntry, "deployKey" | "projectLabel">,
): Promise<string[] | null> {
  const rows = await conn
    .listInstances(entry.projectLabel, entry.deployKey, "")
    .catch(() => null);
  if (rows === null) return null;
  const key = entry.deployKey;
  return rows
    .map((r) => r.name)
    .filter((n) => {
      const bare = n.startsWith("deplo-") ? n.slice("deplo-".length) : n;
      return bare === key || bare.startsWith(`${key}-`);
    });
}

async function attemptTeardown(
  entry: TeardownEntry,
  opts: { verifyFirst: boolean },
): Promise<{ gone: boolean; error: string }> {
  let conn: TeardownAgent;
  try {
    conn = await dial(entry.serverId);
  } catch (e) {
    return { gone: false, error: errMsg(e) };
  }
  try {
    if (opts.verifyFirst) {
      const before = await stackContainers(conn, entry);
      if (before !== null && before.length === 0)
        return { gone: true, error: "" };
    }
    const res = await conn.destroyStack(
      entry.deployKey,
      true,
      entry.reclaimVolumes,
    );
    const left = await stackContainers(conn, entry);
    if (left === null)
      return {
        gone: res.ok,
        error: res.ok ? "" : res.error || "the teardown failed",
      };
    if (left.length === 0) return { gone: true, error: "" };
    await conn.stopStack(entry.deployKey).catch(() => {});
    return {
      gone: false,
      error: `${left.length} container${left.length === 1 ? "" : "s"} survived the teardown${
        res.error ? ` (${res.error})` : ""
      }`,
    };
  } catch (e) {
    return { gone: false, error: errMsg(e) };
  } finally {
    conn.close();
  }
}

async function recordFailure(
  entry: TeardownEntry,
  error: string,
  serverName: string,
  now: Date,
): Promise<void> {
  const rows = await getDb()
    .update(pendingTeardowns)
    .set({ attempts: sql`${pendingTeardowns.attempts} + 1`, lastError: error })
    .where(
      and(
        eq(pendingTeardowns.serverId, entry.serverId),
        eq(pendingTeardowns.deployKey, entry.deployKey),
      ),
    )
    .returning({ attempts: pendingTeardowns.attempts });
  const attempts = rows[0]?.attempts;
  if (attempts === undefined) return;
  const next = nextTeardownAttempt(attempts, now);
  if (!next.giveUp) {
    await getDb()
      .update(pendingTeardowns)
      .set({ nextAttemptAt: next.at })
      .where(
        and(
          eq(pendingTeardowns.serverId, entry.serverId),
          eq(pendingTeardowns.deployKey, entry.deployKey),
        ),
      );
    return;
  }
  await getDb()
    .update(pendingTeardowns)
    .set({ abandonedAt: nowIso() })
    .where(
      and(
        eq(pendingTeardowns.serverId, entry.serverId),
        eq(pendingTeardowns.deployKey, entry.deployKey),
      ),
    );
  await announce(
    entry,
    `Gave up on the teardown of ${entry.label} on ${serverName} after ${attempts} attempts: ${error}`,
    "teardown_abandoned",
  );
}

async function announce(
  entry: TeardownEntry,
  message: string,
  alert: "teardown_abandoned" | null,
): Promise<void> {
  if (entry.teamId) {
    await recordActivity("app", message, "Deplo", null, entry.teamId, alert);
    return;
  }
  console.warn(`[deplo] ${message}`);
  if (alert)
    dispatchServerAlert(entry.serverId, {
      key: alert,
      title: "Leftover containers",
      body: message,
      path: "/activity",
    });
}

async function serverFacts(
  serverId: string,
): Promise<{ name: string; offline: boolean }> {
  const rows = await getDb()
    .select({ name: serversTable.name, status: serversTable.status })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  return {
    name: rows[0]?.name ?? "its server",
    offline: rows[0]?.status === "offline",
  };
}

export async function teardownOrQueue(entry: TeardownEntry): Promise<boolean> {
  await enqueueTeardowns([entry]);
  const { name, offline } = await serverFacts(entry.serverId);
  if (offline) {
    await recordFailure(entry, `${name} is offline`, name, new Date());
    return false;
  }
  const { gone, error } = await attemptTeardown(entry, { verifyFirst: false });
  if (!gone) {
    await recordFailure(entry, error, name, new Date());
    return false;
  }
  await dropTeardown(entry.serverId, entry.deployKey);
  return true;
}

export async function dropTeardown(
  serverId: string,
  deployKey: string,
): Promise<void> {
  await getDb()
    .delete(pendingTeardowns)
    .where(
      and(
        eq(pendingTeardowns.serverId, serverId),
        eq(pendingTeardowns.deployKey, deployKey),
      ),
    );
}

export async function drainTeardowns(now: Date = new Date()): Promise<void> {
  await reopenReachableTeardowns(now).catch((e) =>
    console.error("[deplo] could not reopen teardowns:", errMsg(e)),
  );
  const due = await getDb()
    .select({
      serverId: pendingTeardowns.serverId,
      deployKey: pendingTeardowns.deployKey,
      projectLabel: pendingTeardowns.projectLabel,
      label: pendingTeardowns.label,
      teamId: pendingTeardowns.teamId,
      serverName: serversTable.name,
    })
    .from(pendingTeardowns)
    .innerJoin(serversTable, eq(serversTable.id, pendingTeardowns.serverId))
    .where(
      and(
        isNull(pendingTeardowns.abandonedAt),
        lte(pendingTeardowns.nextAttemptAt, now.toISOString()),
      ),
    )
    .orderBy(asc(pendingTeardowns.nextAttemptAt))
    .limit(DRAIN_BATCH);

  await mapLimit(due, DRAIN_CONCURRENCY, async (row) => {
    const entry: TeardownEntry = {
      serverId: row.serverId,
      deployKey: row.deployKey,
      projectLabel: row.projectLabel,
      label: row.label,
      teamId: row.teamId,
    };
    try {
      const { gone, error } = await attemptTeardown(entry, {
        verifyFirst: true,
      });
      if (!gone) {
        await recordFailure(entry, error, row.serverName, now);
        return;
      }
      await dropTeardown(entry.serverId, entry.deployKey);
      await announce(
        entry,
        `Finished the teardown of ${entry.label} on ${row.serverName}`,
        null,
      );
    } catch (e) {
      console.error(
        `[deplo] teardown of ${row.deployKey} on ${row.serverName} did not finish:`,
        errMsg(e),
      );
    }
  });
}

export async function pendingTeardownsForServer(
  serverId: string,
): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(pendingTeardowns)
    .where(eq(pendingTeardowns.serverId, serverId));
  return rows[0]?.n ?? 0;
}

async function reopenReachableTeardowns(now: Date): Promise<void> {
  const db = getDb();
  const reachable = db
    .select({ id: serversTable.id })
    .from(serversTable)
    .where(
      and(
        eq(serversTable.status, "online"),
        gte(
          serversTable.lastSeenAt,
          new Date(now.getTime() - SEEN_RECENTLY_MS).toISOString(),
        ),
      ),
    );
  await db
    .update(pendingTeardowns)
    .set({ abandonedAt: null, attempts: 0, nextAttemptAt: now.toISOString() })
    .where(
      and(
        lte(
          pendingTeardowns.abandonedAt,
          new Date(now.getTime() - REOPEN_AFTER_MS).toISOString(),
        ),
        inArray(pendingTeardowns.serverId, reachable),
      ),
    );
}
