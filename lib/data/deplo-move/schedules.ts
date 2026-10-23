import "server-only";

import { and, eq, ne } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import { recordActivity } from "../activity";

// ADR-0035: a copied Deplo's crons and backup schedules wait for an admin, so no job runs on both Deplos.
export const SCHEDULES_PAUSED_CACHE_MS = 2_000;

// On globalThis: the schedulers and the route handlers are separate bundles that must share one answer.
const CACHE_KEY = Symbol.for("deplo.move.schedulesPaused");
type Cached = { at: number; db: unknown; value: Promise<boolean> };
const slot = globalThis as unknown as { [CACHE_KEY]?: Cached };

export function invalidateSchedulesPaused(): void {
  delete slot[CACHE_KEY];
}

// True while a move into this Deplo holds its schedules. A manual run never asks.
export function schedulesPaused(): Promise<boolean> {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return Promise.resolve(false);
  }
  const hit = slot[CACHE_KEY];
  if (hit && hit.db === db && Date.now() - hit.at < SCHEDULES_PAUSED_CACHE_MS)
    return hit.value;
  const value = readPaused(db).catch((e) => {
    // Fails open like the freeze: with the database gone no schedule can fire anyway.
    if (slot[CACHE_KEY]?.value === value) invalidateSchedulesPaused();
    console.warn(
      "[deplo-move] could not read whether schedules are paused:",
      e,
    );
    return false;
  });
  slot[CACHE_KEY] = { at: Date.now(), db, value };
  return value;
}

async function readPaused(db: ReturnType<typeof getDb>): Promise<boolean> {
  const [row] = await db
    .select({ id: deploMoves.id })
    .from(deploMoves)
    .where(
      and(
        eq(deploMoves.side, "target"),
        eq(deploMoves.schedulesPaused, true),
        ne(deploMoves.state, "cancelled"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function resumeMoveSchedules(): Promise<void> {
  await requireInstanceAdmin();
  const user = await getCurrentUser();
  const cleared = await getDb()
    .update(deploMoves)
    .set({ schedulesPaused: false, updatedAt: nowIso() })
    .where(
      and(eq(deploMoves.side, "target"), eq(deploMoves.schedulesPaused, true)),
    )
    .returning({ id: deploMoves.id });
  invalidateSchedulesPaused();
  if (cleared.length === 0) return;
  const actor = user?.name || user?.username || "An instance admin";
  const teams = await getDb().select({ id: teamsTable.id }).from(teamsTable);
  for (const { id } of teams)
    await recordActivity(
      "instance",
      "Turned on scheduled jobs and backups after the move",
      actor,
      null,
      id,
    );
}
