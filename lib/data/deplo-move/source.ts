import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
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
import {
  FORWARD_ONLY,
  MoveRefusedError,
  RESUMED,
  enrolledServers,
  handedOverCount,
  isExpired,
  latestSourceMove,
  recordForEveryTeam,
  resumeSourceMove,
  tryThawSourceMove,
} from "./source-row";

// The old Deplo's side of a Deplo move (ADR-0035), as an instance admin sees it.
export interface SourceMoveStatus {
  id: string;
  state: SourceMoveState;
  // The new Deplo, once one has connected with the code.
  peerUrl: string | null;
  // Only while nothing has connected: a bound code lives until the move ends.
  expiresAt: string | null;
  handedOver: number;
  servers: number;
  startedBy: string;
  createdAt: string;
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
  await getDb().transaction(async (tx) => {
    // One code at a time: a new one replaces a code nothing has frozen yet.
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

// `force` resumes this Deplo even when servers already answer to the new one: for when that one is gone.
export async function cancelMoveCode(
  opts: { force?: boolean } = {},
): Promise<void> {
  await requireInstanceAdmin();
  const row = await latestSourceMove();
  if (!row || row.state === RESUMED) return;
  const actor = await actorName();
  if (await tryThawSourceMove(row, actor)) return;
  if (!opts.force)
    throw new MoveRefusedError(
      `${FORWARD_ONLY} If the new Deplo is gone for good, resume this Deplo instead.`,
      409,
    );
  await resumeSourceMove(row, actor);
}

export async function sourceMoveStatus(): Promise<SourceMoveStatus | null> {
  await requireInstanceAdmin();
  const row = await latestSourceMove();
  if (!row || isExpired(row) || row.state === RESUMED) return null;
  const [handedOver, servers] = await Promise.all([
    handedOverCount(row.id),
    enrolledServers(),
  ]);
  return {
    id: row.id,
    state: row.state as SourceMoveState,
    peerUrl: row.peerUrl,
    expiresAt: row.state === "armed" ? row.expiresAt : null,
    handedOver,
    servers: servers.length,
    startedBy: row.startedBy,
    createdAt: row.createdAt,
  };
}
