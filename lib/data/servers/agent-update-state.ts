import "server-only";

import { and, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { serverAgentUpdates } from "../../db/schema/control-plane/servers";
import { AGENT_VERSION } from "../../version";

export type AgentUpdateRow = typeof serverAgentUpdates.$inferSelect;
export type AgentUpdateFailure = "busy" | "unreachable" | "error" | "no_return";

export const GIVE_UP_MS = 24 * 60 * 60_000;
const MAX_BACKOFF_MIN = 60;
// ponytail: a fixed bound on a claim whose process died; longer than any SelfUpdate plus its confirm loop.
export const STALE_RUNNING_MS = 10 * 60_000;

/** The view the dashboard reads: a server with no row is idle. */
export interface AgentUpdateDTO {
  running: boolean;
  failed: boolean;
  gaveUp: boolean;
  attempts: number;
  failure: string;
  lastError: string;
  firstFailedAt: string | null;
  nextRetryAt: string | null;
}

/** 1, 2, 4, 8 … minutes after the n-th failure, capped at an hour. */
export function nextRetryAt(attempts: number, now: Date): string {
  const minutes = Math.min(2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MIN);
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

export function toAgentUpdateDTO(row: AgentUpdateRow): AgentUpdateDTO {
  return {
    running: row.status === "running",
    failed: row.attempts > 0,
    gaveUp: row.status === "failed" && row.nextRetryAt === null,
    attempts: row.attempts,
    failure: row.failure,
    lastError: row.lastError,
    firstFailedAt: row.firstFailedAt,
    nextRetryAt: row.nextRetryAt,
  };
}

/**
 * Take the one attempt slot for a server, atomically across processes. Automatic
 * waits for its retry time; manual skips the wait, the timeout and a fleet pause.
 */
export async function claimAgentUpdate(
  serverId: string,
  manual: boolean,
  now: Date = new Date(),
): Promise<AgentUpdateRow | null> {
  const at = now.toISOString();
  const stale = new Date(now.getTime() - STALE_RUNNING_MS).toISOString();
  const t = serverAgentUpdates;
  const free = or(ne(t.status, "running"), lt(t.updatedAt, stale));
  const due = or(
    and(eq(t.status, "failed"), lte(t.nextRetryAt, at)),
    and(eq(t.status, "running"), lt(t.updatedAt, stale)),
  );
  const rows = await getDb()
    .insert(t)
    .values({
      serverId,
      status: "running",
      targetVersion: AGENT_VERSION,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: t.serverId,
      set: { status: "running", updatedAt: at },
      setWhere: manual ? free : due,
    })
    .returning();
  return rows[0] ?? null;
}

/** Record a failed attempt; the 24 hours run from the first failure and never reset. */
export async function recordAgentUpdateFailure(
  row: AgentUpdateRow,
  failure: AgentUpdateFailure,
  error: string,
  now: Date = new Date(),
): Promise<{ row: AgentUpdateRow; firstFailure: boolean; gaveUp: boolean }> {
  const attempts = row.attempts + 1;
  const firstFailedAt = row.firstFailedAt ?? now.toISOString();
  const gaveUp = now.getTime() - Date.parse(firstFailedAt) >= GIVE_UP_MS;
  const [next] = await getDb()
    .update(serverAgentUpdates)
    .set({
      status: "failed",
      failure,
      attempts,
      firstFailedAt,
      nextRetryAt: gaveUp ? null : nextRetryAt(attempts, now),
      lastError: error.slice(0, 500),
      updatedAt: now.toISOString(),
    })
    .where(eq(serverAgentUpdates.serverId, row.serverId))
    .returning();
  return { row: next, firstFailure: row.firstFailedAt === null, gaveUp };
}

export async function clearAgentUpdate(serverId: string): Promise<void> {
  await getDb()
    .delete(serverAgentUpdates)
    .where(eq(serverAgentUpdates.serverId, serverId));
}

export async function listAgentUpdates(): Promise<Map<string, AgentUpdateRow>> {
  const rows = await getDb().select().from(serverAgentUpdates);
  return new Map(rows.map((r) => [r.serverId, r]));
}

export async function getAgentUpdate(
  serverId: string,
): Promise<AgentUpdateRow | null> {
  const rows = await getDb()
    .select()
    .from(serverAgentUpdates)
    .where(eq(serverAgentUpdates.serverId, serverId));
  return rows[0] ?? null;
}

/** A new pin opens a fresh window for every server. */
export async function dropStaleAgentUpdates(): Promise<void> {
  await getDb()
    .delete(serverAgentUpdates)
    .where(ne(serverAgentUpdates.targetVersion, AGENT_VERSION));
}

/**
 * What a live Hello says about a pending update: an agent on the pin closes it, and
 * one that was unreachable when Deplo gave up earns exactly one more attempt.
 */
export async function agentSeen(
  serverId: string,
  onPin: boolean,
): Promise<void> {
  const t = serverAgentUpdates;
  if (onPin) {
    await getDb()
      .delete(t)
      .where(and(eq(t.serverId, serverId), ne(t.status, "running")));
    return;
  }
  await getDb()
    .update(t)
    .set({ nextRetryAt: sql`now()`, revived: true })
    .where(
      and(
        eq(t.serverId, serverId),
        eq(t.status, "failed"),
        isNull(t.nextRetryAt),
        eq(t.failure, "unreachable"),
        eq(t.revived, false),
      ),
    );
}
