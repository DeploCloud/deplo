import "server-only";

import { and, asc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";

import { runWithIdentity } from "../../auth/request-context";
import { acquireLease, releaseLease } from "../../backups/lease";
import { getDb } from "../../db/client";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { publishMigrationChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import { abortRunCopy } from "../migration-data/move";
import { markRunTargetsUncopied } from "../migration-data/recopy";
import { undoMigration } from "../migration-import/revert";
import { cancelQueuedRuns } from "../migration-import/run-queries";
import {
  appendRunItem,
  releaseMigrating,
} from "../migration-import/run-report";
import {
  handOverMigrationSources,
  removeSourcesOfRun,
} from "../migration-import/source-agents";
import { runConfigPhase } from "./config-phase";
import { runDataPhase } from "./data-phase";
import { beat } from "./heartbeat";
import type { RunRow } from "./runner-state";
import {
  IDLE_TICK_MS,
  LeaseLost,
  STALE_MS,
  credentialFor,
  inflight,
  leaseFor,
  lostLeases,
  owner,
  panelNameFor,
} from "./runner-state";
import { stopWanted, stopped } from "./stop";

let timer: ReturnType<typeof setInterval> | null = null;

export async function runMigrationTick(): Promise<void> {
  try {
    await promoteQueuedRuns();
  } catch (e) {
    console.error("[migration] promoting the queue failed:", e);
  }
  try {
    const now = new Date();
    const cold = new Date(now.getTime() - STALE_MS).toISOString();
    const rows = await getDb()
      .select()
      .from(runsTable)
      .where(
        and(
          eq(runsTable.status, "running"),
          isNotNull(runsTable.apiKeyEnc),
          or(
            isNull(runsTable.runnerOwner),
            eq(runsTable.runnerOwner, owner),
            isNull(runsTable.heartbeatAt),
            lt(runsTable.heartbeatAt, cold),
          ),
        ),
      )
      .orderBy(asc(runsTable.seq));
    await Promise.all(rows.filter((r) => !inflight.has(r.id)).map(drive));
  } catch (e) {
    console.error("[migration] tick failed:", e);
  }
}

async function promoteQueuedRuns(): Promise<void> {
  const waiting = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.status, "queued"))
    .orderBy(asc(runsTable.seq));
  const seen = new Set<string>();
  for (const next of waiting) {
    const sessionId = next.sessionId;
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const siblings = await getDb()
      .select()
      .from(runsTable)
      .where(eq(runsTable.sessionId, sessionId))
      .orderBy(asc(runsTable.seq));
    if (siblings.some((s) => s.status === "running")) continue;
    const before = siblings.filter((s) => s.status !== "queued").pop();
    if (before && before.status !== "done") {
      const why = `The team before this one ${before.status === "stopped" ? "was stopped" : "did not finish"}, so the rest of the migration did not start.`;
      await cancelQueuedRuns(sessionId, why);
      if (before.actorUserId)
        await runWithIdentity(
          { userId: before.actorUserId, teamId: before.teamId },
          () => removeSourcesOfRun(before.id, before.teamId),
        ).catch((e) =>
          console.error("[migration] clearing sources after a stop:", e),
        );
      continue;
    }
    if (!next.actorUserId) {
      await cancelQueuedRuns(
        sessionId,
        "This team was queued by a run Deplo can no longer resume.",
      );
      continue;
    }
    try {
      await runWithIdentity(
        { userId: next.actorUserId, teamId: next.teamId },
        () => handOverMigrationSources(before?.teamId ?? null),
      );
    } catch (e) {
      console.error("[migration] handing the sources to the next team:", e);
      continue;
    }
    await getDb()
      .update(runsTable)
      .set({
        status: "running",
        startedAt: nowIso(),
        heartbeatAt: null,
        runnerOwner: null,
        phase: "config",
      })
      .where(and(eq(runsTable.id, next.id), eq(runsTable.status, "queued")));
    publishMigrationChanged();
  }
}

async function drive(row: RunRow): Promise<void> {
  if (inflight.has(row.id)) return;
  inflight.add(row.id);
  let held = false;
  try {
    held = await acquireLease(leaseFor(row.id), owner, new Date(), STALE_MS);
    if (!held) return;
    await advance(row);
  } catch (e) {
    if (e instanceof LeaseLost || lostLeases.has(row.id)) {
      lostLeases.delete(row.id);
      held = false;
      return;
    }
    console.error("[migration] run", row.id, "failed:", e);
    await failRun(row, e instanceof Error ? e.message : String(e));
  } finally {
    inflight.delete(row.id);
    if (held) await releaseLease(leaseFor(row.id), owner).catch(() => {});
  }
}

export function startMigrationRunner(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runMigrationTick();
  }, IDLE_TICK_MS);
  timer.unref?.();
  void runMigrationTick();
}

export async function releaseMigrationRunnerLease(): Promise<void> {
  for (const runId of inflight)
    await releaseLease(leaseFor(runId), owner).catch(() => {});
}

async function failRun(row: RunRow, why: string): Promise<void> {
  const [before] = await getDb()
    .select({ phase: runsTable.phase })
    .from(runsTable)
    .where(eq(runsTable.id, row.id))
    .limit(1);
  const reached = before?.phase ?? row.phase;

  await getDb()
    .update(runsTable)
    .set({
      status: "failed",
      error: why,
      finishedAt: nowIso(),
      reportSeenAt: nowIso(),
      apiKeyEnc: null,
      runnerOwner: null,
      phase: "done",
    })
    .where(and(eq(runsTable.id, row.id), eq(runsTable.status, "running")));
  publishMigrationChanged();

  await releaseMigrating(row.id);

  if (reached === "data") {
    await markRunTargetsUncopied(row.id, why).catch(() => 0);
    await appendRunItem(row.id, panelNameFor(row), {
      path: "Migration",
      sourceKind: "run",
      sourceName: "Migration",
      outcome: "manual",
      message: `The data step stopped: ${why} Everything already created here was kept - nothing was rolled back. The lines above name every service whose data did not come across; each one refuses to deploy until you bring its data over yourself or choose "Deploy anyway" on its page.`,
    });
    return;
  }

  if (!row.actorUserId) return;
  try {
    await runWithIdentity({ userId: row.actorUserId, teamId: row.teamId }, () =>
      undoMigration(row.id, { forceSourceRemoval: false }),
    );
  } catch (e) {
    console.error("[migration] undo after failure", row.id, "failed:", e);
  }
}

async function advance(row: RunRow): Promise<void> {
  if (!row.actorUserId)
    throw new Error("This run was started before Deplo could resume one.");
  await beat(row.id);
  const heart = setInterval(() => {
    void beat(row.id).catch(() => {});
    void stopWanted(row.id)
      .then((yes) => yes && abortRunCopy(row.id))
      .catch(() => {});
  }, IDLE_TICK_MS);
  heart.unref?.();
  try {
    await runWithIdentity({ userId: row.actorUserId, teamId: row.teamId }, () =>
      advanceAsActor(row),
    );
  } finally {
    clearInterval(heart);
  }
}

async function advanceAsActor(row: RunRow): Promise<void> {
  if (await stopped(row.id)) return;
  const c = await credentialFor(row);

  if (row.phase === "config") {
    await runConfigPhase(row, c);
    if (await stopped(row.id)) return;
  }
  await runDataPhase(row, c);
}
