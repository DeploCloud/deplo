import "server-only";

import { and, desc, eq, lt } from "drizzle-orm";

import { getDb } from "../db/client";
import { deploUpdateLog } from "../db/schema/control-plane/instance";
import { newId, nowIso } from "../ids";
import { requireInstanceAdmin } from "../membership";
import { bareVersion, DEPLO_VERSION, versionTag } from "../version";
import { readRefusedNote } from "./update-stops/refused";

// button: an admin clicked Update. host: the installer ran on the machine, outside Deplo.
export type UpdateTrigger = "button" | "automatic" | "host";
export type UpdateOutcome = "running" | "updated" | "rolled_back" | "failed";

export interface UpdateLogEntry {
  id: string;
  trigger: UpdateTrigger;
  outcome: UpdateOutcome;
  fromVersion: string;
  toVersion: string;
  actor: string | null;
  reason: string | null;
  at: string;
  finishedAt: string | null;
}

type Row = typeof deploUpdateLog.$inferSelect;

const KEEP_MS = 90 * 24 * 60 * 60_000;
const MAX_ENTRIES = 200;
// Long past the installer's own 2-minute wait, so only an update that never got going reads as failed.
export const UNFINISHED_AFTER_MS = 30 * 60_000;

/** Opens the row for an update about to start; returns its id. */
export async function logUpdateStarted(entry: {
  to: string;
  trigger: UpdateTrigger;
  actor: string | null;
}): Promise<string> {
  const id = newId("dupd");
  await getDb()
    .insert(deploUpdateLog)
    .values({
      id,
      trigger: entry.trigger,
      outcome: "running",
      fromVersion: versionTag(DEPLO_VERSION),
      toVersion: versionTag(entry.to),
      actor: entry.actor,
      at: nowIso(),
    });
  return id;
}

export async function logUpdateFailed(id: string, reason: string) {
  await getDb()
    .update(deploUpdateLog)
    .set({ outcome: "failed", reason, finishedAt: nowIso() })
    .where(eq(deploUpdateLog.id, id));
}

export async function logUpdateLogPath(id: string, logPath: string) {
  await getDb()
    .update(deploUpdateLog)
    .set({ logPath })
    .where(eq(deploUpdateLog.id, id));
}

/** At boot, before `booted_version` moves: closes the open rows, or records an update the installer ran by itself. */
export async function settleUpdateLogAtBoot(
  previous: string | null,
): Promise<void> {
  const db = getDb();
  const here = versionTag(DEPLO_VERSION);
  const now = nowIso();
  const refused = await readRefusedNote();
  const open = await db
    .select()
    .from(deploUpdateLog)
    .where(eq(deploUpdateLog.outcome, "running"));

  let closed = false;
  for (const row of open) {
    if (row.toVersion === here) {
      await db
        .update(deploUpdateLog)
        .set({ outcome: "updated", finishedAt: now })
        .where(eq(deploUpdateLog.id, row.id));
      closed = true;
    } else if (
      refused &&
      (refused.version ?? row.toVersion) === row.toVersion &&
      (!refused.at || Date.parse(refused.at) >= Date.parse(row.at))
    ) {
      await db
        .update(deploUpdateLog)
        .set({
          outcome: "rolled_back",
          reason: refused.reason,
          finishedAt: refused.at ?? now,
        })
        .where(eq(deploUpdateLog.id, row.id));
      closed = true;
    }
  }
  if (closed) return;

  // The note stays until an update succeeds, so every boot meets it: write it once.
  if (refused) {
    if (!refused.version || !refused.at) return;
    const seen = await db
      .select({ id: deploUpdateLog.id })
      .from(deploUpdateLog)
      .where(
        and(
          eq(deploUpdateLog.outcome, "rolled_back"),
          eq(deploUpdateLog.toVersion, refused.version),
          eq(deploUpdateLog.finishedAt, refused.at),
        ),
      )
      .limit(1);
    if (seen.length > 0) return;
    await db.insert(deploUpdateLog).values({
      id: newId("dupd"),
      trigger: "host",
      outcome: "rolled_back",
      fromVersion: here,
      toVersion: refused.version,
      reason: refused.reason,
      at: refused.at,
      finishedAt: refused.at,
    });
    return;
  }

  if (!previous || bareVersion(previous) === DEPLO_VERSION) return;
  await db.insert(deploUpdateLog).values({
    id: newId("dupd"),
    trigger: "host",
    outcome: "updated",
    fromVersion: versionTag(previous),
    toVersion: here,
    at: now,
    finishedAt: now,
  });
}

/** A row still open long after it started never reached the new version: it shows as failed. */
export function effectiveEntry(row: Row, now = Date.now()): UpdateLogEntry {
  const entry: UpdateLogEntry = {
    id: row.id,
    trigger: row.trigger as UpdateTrigger,
    outcome: row.outcome as UpdateOutcome,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    actor: row.actor,
    reason: row.reason,
    at: row.at,
    finishedAt: row.finishedAt,
  };
  if (
    row.outcome !== "running" ||
    now - Date.parse(row.at) < UNFINISHED_AFTER_MS
  )
    return entry;
  return {
    ...entry,
    outcome: "failed",
    reason: row.logPath
      ? `The update did not finish. The machine wrote the run to ${row.logPath}.`
      : "The update did not finish.",
  };
}

// Ungated for the automatic updates, which read their own history with no one signed in.
export async function readUpdateLog(
  limit = MAX_ENTRIES,
): Promise<UpdateLogEntry[]> {
  const rows = await getDb()
    .select()
    .from(deploUpdateLog)
    .orderBy(desc(deploUpdateLog.at), desc(deploUpdateLog.id))
    .limit(Math.min(Math.max(limit, 1), MAX_ENTRIES));
  const now = Date.now();
  return rows.map((r) => effectiveEntry(r, now));
}

export async function listUpdateLog(): Promise<UpdateLogEntry[]> {
  await requireInstanceAdmin();
  return readUpdateLog();
}

export async function sweepUpdateLog(now = new Date()): Promise<void> {
  await getDb()
    .delete(deploUpdateLog)
    .where(
      lt(deploUpdateLog.at, new Date(now.getTime() - KEEP_MS).toISOString()),
    );
}
