import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  deploMovePauses,
  deploMoves,
} from "../../db/schema/control-plane/deplo-move";
import { randomToken, sha256Hex } from "../../crypto";
import { newId, nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import {
  MOVE_CODE_PREFIX,
  MOVE_CODE_TTL_MS,
  type SourceMoveState,
} from "../../deplo-move/protocol";
import { actorName } from "../members/activity-actor";
import { InstanceFrozenError, instanceFrozen } from "./freeze";
import { resumeAllPauses } from "./source-pauses";
import {
  CANCELLED,
  MoveRefusedError,
  isExpired,
  latestSourceMove,
  peerOf,
  recordForEveryTeam,
  type SourceMoveRow,
} from "./source-row";

// The old Deplo's side of a Deplo move (ADR-0035), as an instance admin sees it.
export interface SourceMoveStatus {
  id: string;
  state: SourceMoveState;
  // The new Deplo, once one has connected with the code.
  peerUrl: string | null;
  // Only while nothing has connected: a bound code lives until the copy ends.
  expiresAt: string | null;
  startedBy: string;
  createdAt: string;
  finishedAt: string | null;
}

export async function createMoveCode(): Promise<{
  code: string;
  expiresAt: string;
}> {
  await requireInstanceAdmin();
  const frozen = await instanceFrozen();
  if (frozen) throw new InstanceFrozenError(frozen);

  const code = `${MOVE_CODE_PREFIX}${randomToken(24)}`;
  const now = nowIso();
  const expiresAt = new Date(Date.now() + MOVE_CODE_TTL_MS).toISOString();
  const startedBy = await actorName();
  const db = getDb();
  await db.transaction(async (tx) => {
    const running = await tx.$count(
      deploMoves,
      and(eq(deploMoves.side, "source"), eq(deploMoves.state, "copying")),
    );
    if (running > 0)
      throw new MoveRefusedError(
        "A copy of this Deplo is running. Cancel it first.",
        409,
      );
    // One code at a time. A move that copied anything stays: another Deplo shares this one's backups (team-delete.ts).
    await tx
      .delete(deploMoves)
      .where(
        and(
          eq(deploMoves.side, "source"),
          inArray(deploMoves.state, ["armed", "bound"]),
        ),
      );
    await tx.insert(deploMoves).values({
      id: newId("dmv"),
      side: "source",
      state: "armed",
      codeHash: sha256Hex(code),
      expiresAt,
      startedBy,
      createdAt: now,
      updatedAt: now,
    });
  });
  await recordForEveryTeam("Created a code to move this Deplo", startedBy);
  return { code, expiresAt };
}

function cancelledMessage(row: Pick<SourceMoveRow, "state" | "peerUrl">) {
  return row.state === "armed"
    ? "Cancelled the code to move this Deplo"
    : `Cancelled copying this Deplo to ${peerOf(row)}`;
}

// Starts every workload the copy paused. A code that never copied is forgotten; one that did stays on record, code-less.
export async function cancelSourceMove(
  row: SourceMoveRow,
  actor: string,
): Promise<void> {
  await resumeAllPauses(row.id);
  const cancelled = await getDb().transaction(async (tx) => {
    const [live] = await tx
      .select({ state: deploMoves.state, peerUrl: deploMoves.peerUrl })
      .from(deploMoves)
      .where(eq(deploMoves.id, row.id))
      .for("update");
    if (!live || live.state === CANCELLED) return null;
    if (live.state === "done")
      throw new MoveRefusedError(
        "This copy already finished, so there is nothing to cancel.",
        409,
      );
    const held = await tx.$count(
      deploMovePauses,
      eq(deploMovePauses.moveId, row.id),
    );
    if (live.state === "copying" || held > 0)
      await tx
        .update(deploMoves)
        .set({ state: CANCELLED, codeHash: null, updatedAt: nowIso() })
        .where(eq(deploMoves.id, row.id));
    else await tx.delete(deploMoves).where(eq(deploMoves.id, row.id));
    return live;
  });
  if (cancelled) await recordForEveryTeam(cancelledMessage(cancelled), actor);
}

export async function cancelMoveCode(): Promise<void> {
  await requireInstanceAdmin();
  const row = await latestSourceMove();
  if (!row || row.state === "done") return;
  await cancelSourceMove(row, await actorName());
}

export async function sourceMoveStatus(): Promise<SourceMoveStatus | null> {
  await requireInstanceAdmin();
  const row = await latestSourceMove();
  if (!row || isExpired(row)) return null;
  return {
    id: row.id,
    state: row.state as SourceMoveState,
    peerUrl: row.peerUrl,
    expiresAt: row.state === "armed" ? row.expiresAt : null,
    startedBy: row.startedBy,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}
