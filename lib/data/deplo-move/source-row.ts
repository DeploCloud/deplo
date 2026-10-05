import "server-only";

import { and, desc, eq, ne } from "drizzle-orm";

import { getDb } from "../../db/client";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { recordActivity } from "../activity";

export type SourceMoveRow = typeof deploMoves.$inferSelect;

// Stored on this machine only, never on the wire: a copy cancelled after it started, kept as a record.
export const CANCELLED = "cancelled";

export class MoveRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // The agent's gRPC status when the refusal is the agent's own (5 = not found). Not `code`: that reads as internal.
    readonly agentCode?: number,
  ) {
    super(message);
    this.name = "MoveRefusedError";
  }
}

export async function latestSourceMove(): Promise<SourceMoveRow | null> {
  const [row] = await getDb()
    .select()
    .from(deploMoves)
    .where(and(eq(deploMoves.side, "source"), ne(deploMoves.state, CANCELLED)))
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

export function peerOf(row: Pick<SourceMoveRow, "peerUrl">): string {
  return row.peerUrl ?? "another machine";
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
