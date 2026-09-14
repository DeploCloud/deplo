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

// runMigrationTick - one pass over whatever is running. Never throws: one broken
// migration must not take the timer down with it.
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
          // ONLY runs this runner owns. A run with no stored key was started by
          // a tab that is driving it itself - picking it up would find no
          // credential and mark somebody's live migration failed.
          isNotNull(runsTable.apiKeyEnc),
          // Ours, or nobody's, or a heartbeat that went cold with the process
          // holding it.
          or(
            isNull(runsTable.runnerOwner),
            eq(runsTable.runnerOwner, owner),
            isNull(runsTable.heartbeatAt),
            lt(runsTable.heartbeatAt, cold),
          ),
        ),
      )
      .orderBy(asc(runsTable.seq));
    // Concurrently, and each behind its OWN lease: a run this process is already
    // driving is skipped rather than waited on, so the tick that follows a
    // 40-minute copy still starts the migration somebody began five minutes ago.
    await Promise.all(rows.filter((r) => !inflight.has(r.id)).map(drive));
  } catch (e) {
    console.error("[migration] tick failed:", e);
  }
}

// The turn AFTER: every session whose team has finished and whose next has not
// started. Driven off the rows alone, so a control plane that died mid-walk
// picks the queue up on its first tick.
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
    // Its turn has not come: one of this panel's teams is still moving.
    if (siblings.some((s) => s.status === "running")) continue;
    const before = siblings.filter((s) => s.status !== "queued").pop();
    if (before && before.status !== "done") {
      // The team before it did not land. Carrying on would import the next team
      // through machines a failure has just been undone on.
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
      // The machines are read team by team, and every lookup that reads one is
      // team-scoped: they follow the turn.
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

// Take one run, if nobody else has it, and see it through. The claim is marked
// BEFORE the first `await`, and that ordering is the whole guard.
async function drive(row: RunRow): Promise<void> {
  if (inflight.has(row.id)) return;
  inflight.add(row.id);
  let held = false;
  try {
    held = await acquireLease(leaseFor(row.id), owner, new Date(), STALE_MS);
    if (!held) return;
    await advance(row);
  } catch (e) {
    // The run is somebody else's now: nothing here is a failure of the run.
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

// startMigrationRunner - start the timer that keeps migrations moving. Called once, at boot.
export function startMigrationRunner(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runMigrationTick();
  }, IDLE_TICK_MS);
  timer.unref?.();
  void runMigrationTick();
}

// releaseMigrationRunnerLease - hand the lease back on SIGTERM/SIGINT, so the next
// control plane picks the migration up on its first tick.
export async function releaseMigrationRunnerLease(): Promise<void> {
  for (const runId of inflight)
    await releaseLease(leaseFor(runId), owner).catch(() => {});
}

// Close a run as failed and take it back out. Debris is a CONFIG phase that
// could not finish: once the data phase has begun, what the run created is the
// user's new infrastructure.
async function failRun(row: RunRow, why: string): Promise<void> {
  // The phase it broke IN. `row` is the snapshot the tick opened with, and the
  // update below overwrites the column, so it has to be read first.
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
      // Nothing to acknowledge: a failed run has no report screen, and left
      // unseen it reopened the wizard, with the same toast, on every visit.
      reportSeenAt: nowIso(),
      apiKeyEnc: null,
      runnerOwner: null,
      phase: "done",
    })
    .where(and(eq(runsTable.id, row.id), eq(runsTable.status, "running")));
  publishMigrationChanged();

  // The run is over, so everything it created is the team's again: without this
  // the apps stayed frozen behind a migration that no longer existed.
  await releaseMigrating(row.id);

  if (reached === "data") {
    // A fault outside the per-service loop left the services it never reached
    // unmarked and deployable on empty storage, under a line claiming otherwise.
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

  // Under the actor, like everything else the runner does - the undo is a stack
  // of ordinary capability-gated deletes.
  if (!row.actorUserId) return;
  try {
    await runWithIdentity({ userId: row.actorUserId, teamId: row.teamId }, () =>
      // Not forced: data that did not copy is still over there, and the next
      // attempt needs the machine readable.
      undoMigration(row.id, { forceSourceRemoval: false }),
    );
  } catch (e) {
    console.error("[migration] undo after failure", row.id, "failed:", e);
  }
}

// Everything one run needs, done under the identity of whoever started it.
async function advance(row: RunRow): Promise<void> {
  if (!row.actorUserId)
    throw new Error("This run was started before Deplo could resume one.");
  await beat(row.id);
  // The steps beat between themselves, and one step can be a 900 MB volume
  // crossing two hosts - minutes in which nothing beat at all.
  const heart = setInterval(() => {
    void beat(row.id).catch(() => {});
    // And it carries the STOP inwards.
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
