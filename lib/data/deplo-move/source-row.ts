import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  deploMoves,
  deploMoveServers,
} from "../../db/schema/control-plane/deplo-move";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { startDeployQueue } from "../../deploy/deploy-queue";
import { connectAgent } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { HEALTH_HELLO_TIMEOUT_MS } from "../../infra/agent-client/deadlines";
import { nowIso } from "../../ids";
import { recordActivity } from "../activity";
import { invalidateFrozen } from "./freeze";

export type SourceMoveRow = typeof deploMoves.$inferSelect;

// Stored on this machine only, never on the wire: an admin resumed this Deplo before the move finished.
export const RESUMED = "resumed";

export class MoveRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // Set when the refusal is "that server already answers to the new Deplo".
    readonly handedOver = false,
  ) {
    super(message);
    this.name = "MoveRefusedError";
  }
}

export const FORWARD_ONLY =
  "A server already answers to the new Deplo, so this move can only go forward. Retry it from the new Deplo.";

export async function latestSourceMove(): Promise<SourceMoveRow | null> {
  const [row] = await getDb()
    .select()
    .from(deploMoves)
    .where(eq(deploMoves.side, "source"))
    .orderBy(desc(deploMoves.updatedAt))
    .limit(1);
  return row ?? null;
}

export function isExpired(row: SourceMoveRow, now = Date.now()): boolean {
  return (
    row.state === "armed" &&
    (!row.expiresAt || Date.parse(row.expiresAt) <= now)
  );
}

function alreadyMoved(row: Pick<SourceMoveRow, "peerUrl">): MoveRefusedError {
  return new MoveRefusedError(
    `This Deplo already moved to ${row.peerUrl ?? "another machine"}.`,
    409,
  );
}

// An install in flight counts: once the request left, the agent may already answer to the new Deplo.
const COMMITTED = ["handed_over", "waiting"];

export async function handedOverCount(moveId: string): Promise<number> {
  return getDb().$count(
    deploMoveServers,
    and(
      eq(deploMoveServers.moveId, moveId),
      eq(deploMoveServers.state, "handed_over"),
    ),
  );
}

export async function enrolledServers(): Promise<
  { id: string; name: string }[]
> {
  return getDb()
    .select({ id: serversTable.id, name: serversTable.name })
    .from(serversTable)
    .where(
      and(
        isNotNull(serversTable.agentCertFingerprint),
        ne(serversTable.agentCertFingerprint, ""),
      ),
    );
}

// A move touches the whole instance, so every team's Activity says so.
export async function recordForEveryTeam(
  message: string,
  actor: string,
): Promise<void> {
  const rows = await getDb().select({ id: teamsTable.id }).from(teamsTable);
  for (const { id } of rows)
    await recordActivity("instance", message, actor, null, id);
}

export async function probeAgent(
  serverId: string,
): Promise<{ capabilities: string[]; version: string } | null> {
  let conn: AgentConnection | null = null;
  try {
    conn = await connectAgent(serverId);
    const hello = await conn.hello(HEALTH_HELLO_TIMEOUT_MS);
    return {
      capabilities: hello.capabilities ?? [],
      version: hello.agentVersion,
    };
  } catch {
    return null;
  } finally {
    conn?.close();
  }
}

// Server ids whose install request this process is sending; on globalThis so every bundle shares one set.
const INSTALLING = Symbol.for("deplo.move.installing");

export function installsInFlight(): Set<string> {
  const g = globalThis as unknown as { [INSTALLING]?: Set<string> };
  return (g[INSTALLING] ??= new Set());
}

const NEVER_INSTALLED =
  "Still answers to this Deplo, so the new certificate never reached it.";

// A `waiting` server that still answers here never took the new authority, so it no longer pins the move.
async function settleWaitingServers(moveId: string): Promise<void> {
  const waiting = await getDb()
    .select({
      serverId: deploMoveServers.serverId,
      updatedAt: deploMoveServers.updatedAt,
    })
    .from(deploMoveServers)
    .where(
      and(
        eq(deploMoveServers.moveId, moveId),
        eq(deploMoveServers.state, "waiting"),
      ),
    );
  const inFlight = installsInFlight();
  await Promise.all(
    waiting.map(async (w) => {
      if (inFlight.has(w.serverId)) return;
      const answers = await probeAgent(w.serverId);
      // An install may have started while the probe ran; one that already re-marked the row misses the update.
      if (!answers || inFlight.has(w.serverId)) return;
      await getDb()
        .update(deploMoveServers)
        .set({ state: "failed", error: NEVER_INSTALLED, updatedAt: nowIso() })
        .where(
          and(
            eq(deploMoveServers.moveId, moveId),
            eq(deploMoveServers.serverId, w.serverId),
            eq(deploMoveServers.state, "waiting"),
            eq(deploMoveServers.updatedAt, w.updatedAt),
          ),
        );
    }),
  );
}

function restartAfterFreeze(): void {
  void startDeployQueue().catch((e) =>
    console.error("[deplo-move] could not restart the deploy queue:", e),
  );
  // A boot while frozen skipped it.
  void import("../apps/delete")
    .then(({ resumeAppDeletes }) => resumeAppDeletes())
    .catch((e) =>
      console.error("[deplo-move] unfinished app deletes could not resume:", e),
    );
}

// Deletes the source row unless a server is committed. Under the row's lock, so a racing install sees one or the other.
export async function tryThawSourceMove(
  row: SourceMoveRow,
  actor: string,
): Promise<boolean> {
  if (row.state === "moved") throw alreadyMoved(row);
  await settleWaitingServers(row.id);
  const thawed = await getDb().transaction(async (tx) => {
    const [live] = await tx
      .select({ state: deploMoves.state, peerUrl: deploMoves.peerUrl })
      .from(deploMoves)
      .where(eq(deploMoves.id, row.id))
      .for("update");
    if (!live) return null;
    if (live.state === "moved") throw alreadyMoved(live);
    const committed = await tx.$count(
      deploMoveServers,
      and(
        eq(deploMoveServers.moveId, row.id),
        inArray(deploMoveServers.state, COMMITTED),
      ),
    );
    if (committed > 0) return false;
    await tx.delete(deploMoves).where(eq(deploMoves.id, row.id));
    return { wasFrozen: live.state === "frozen" };
  });
  if (thawed === false) return false;
  // Gone already: whoever deleted it wrote the Activity.
  if (thawed === null) return true;
  invalidateFrozen();
  await recordForEveryTeam("Cancelled moving this Deplo", actor);
  if (thawed.wasFrozen) restartAfterFreeze();
  return true;
}

export async function thawSourceMove(
  row: SourceMoveRow,
  actor: string,
): Promise<void> {
  if (!(await tryThawSourceMove(row, actor)))
    throw new MoveRefusedError(FORWARD_ONLY, 409);
}

function resumedMessage(names: string[]): string {
  if (names.length === 0)
    return "Resumed this Deplo without finishing the move";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Resumed this Deplo without finishing the move; ${list} ${names.length === 1 ? "answers" : "answer"} to the other Deplo and must be added again.`;
}

// The disaster case: the new Deplo is gone mid-handover. Its servers' rows stay as they are, as the record.
export async function resumeSourceMove(
  row: SourceMoveRow,
  actor: string,
): Promise<void> {
  const lost = await getDb().transaction(async (tx) => {
    const [live] = await tx
      .select({ state: deploMoves.state, peerUrl: deploMoves.peerUrl })
      .from(deploMoves)
      .where(eq(deploMoves.id, row.id))
      .for("update");
    if (!live || live.state === RESUMED) return null;
    if (live.state === "moved") throw alreadyMoved(live);
    const now = nowIso();
    await tx
      .update(deploMoves)
      .set({ state: RESUMED, updatedAt: now, finishedAt: now })
      .where(eq(deploMoves.id, row.id));
    return tx
      .select({ name: deploMoveServers.name })
      .from(deploMoveServers)
      .where(
        and(
          eq(deploMoveServers.moveId, row.id),
          inArray(deploMoveServers.state, COMMITTED),
        ),
      )
      .orderBy(asc(deploMoveServers.position));
  });
  if (!lost) return;
  invalidateFrozen();
  await recordForEveryTeam(resumedMessage(lost.map((s) => s.name)), actor);
  restartAfterFreeze();
}
