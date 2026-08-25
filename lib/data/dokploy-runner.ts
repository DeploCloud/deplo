import "server-only";

import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  dokployImports as runsTable,
  dokployRunServers as runServersTable,
  dokployRunTargets as targetsTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { formatBytes } from "../utils";
import { encryptSecret, decryptSecretOrThrow } from "../crypto";
import { runWithIdentity } from "../auth/request-context";
import { acquireLease, releaseLease } from "../backups/lease";
import { publishMigrationChanged } from "../graphql/pubsub";
import type { ServicePlacement } from "./dokploy-import";
import {
  appendRunItem,
  assertImportGate,
  beginDokployImport,
  finishDokployImport,
  importDokployProject,
  stopDokployImport,
  undoDokployImport,
} from "./dokploy-import";
import {
  abortRunCopy,
  moveDokployServiceData,
  planDokployDataMove,
} from "./dokploy-data";
import { isCopyAborted } from "./volume-migration";
import { checkServerHealth } from "./server-health";
import { listServersForTeam } from "./servers";

/**
 * The import loop, moved out of the browser tab.
 *
 * It used to live in the tab because the tab held the Dokploy API key, which was
 * never stored - and that one property cost everything else. A reload killed the
 * run mid-flight: projects created here, services stopped over there, a row
 * saying `running` with nobody running it, and a panel showing the
 * organisation's name where the progress should be, because the plan that knew
 * the progress had died with the tab. Closing a laptop was a data-loss event.
 *
 * So the key is stored, encrypted, and wiped the moment the run leaves
 * `running`; the choice is stored as rows; and a lease-guarded tick finishes the
 * job. The tab becomes a VIEWER - it can be closed, reloaded, or replaced by
 * somebody else's tab, and the migration does not notice.
 *
 * Everything it does goes through the SAME functions the tab called, under
 * `runWithIdentity` for the person who started it - the pattern the deploy hook
 * and the MCP server already use. A background job with its own capability
 * checks would be a second authorization model, and this repo has one.
 */

/**
 * One lease PER RUN, not one for the instance.
 *
 * It used to be a single `dokploy-migration-runner` row, on the reasoning that
 * migrations are rare and heavy so one at a time is plenty. What that actually
 * built was a starvation bug with no symptom: the lease is renewed on every beat
 * of the run being driven, so a control plane copying a 15 GB volume held it for
 * the hour that took - and a second migration started meanwhile sat at
 * "Migration in progress" with no runner, no heartbeat and not one line of log,
 * for as long as the first one ran. It got worse with an ORPHANED control plane
 * (a process that survived a restart, ppid 1, no port): it holds the lease and
 * drives runs, while the control plane actually serving the panel can never take
 * it.
 *
 * Per run, the lease means what a lease is for - two processes must not drive
 * the SAME run - and it cannot mean anything else.
 */
const leaseFor = (runId: string) => `dokploy-migration:${runId}`;
/** A heartbeat older than this is a control plane that died; take the run over.
 *
 *  It is the LEASE's staleness too, not only the run's. The lease defaults to two
 *  hours, which is right for a scheduler that ticks once a minute and wrong here:
 *  a control plane killed mid-migration held the runner shut for two hours, and
 *  the only symptom was that nothing moved. Safe to shorten only because the
 *  lease is now renewed on every beat - the idle tick's and the one that runs
 *  THROUGH a long step (see {@link advance}), which is what a 900 MB volume copy
 *  used to look abandoned for. */
const STALE_MS = 90_000;
/** How often the tick runs when nothing is going on. */
const IDLE_TICK_MS = 15_000;
/** How often a copy in flight refreshes its byte count on the progress line. */
const PROGRESS_MS = 1_000;

const owner = `${process.pid}-${newId("run")}`;

/** Runs this process is driving right now. One `advance` per run, never two -
 *  and a long one never keeps the tick from picking up a different run. */
const inflight = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/** What a run needs to talk to Dokploy, decrypted for the length of one step. */
interface RunCredential {
  url: string;
  apiKey: string;
  allowPrivate: boolean;
}

export interface StartRunInput {
  url: string;
  apiKey: string;
  allowPrivate: boolean;
  orgName?: string | null;
  /** One entry per SERVICE, in the order they should be worked through. */
  targets: {
    projectId: string;
    projectName: string;
    serviceId: string;
    serverId?: string | null;
    buildServerId?: string | null;
    /** Omit to keep the source's port; `null` publishes nothing. */
    exposedPort?: number | null;
    exposedPortSet?: boolean;
  }[];
  /** Dokploy machine id (`''` for its own host) to the Deplo server it lands on. */
  servers: { from: string; to: string }[];
}

/**
 * Open a run, write down everything needed to finish it, and start it moving.
 *
 * Gated exactly like the loop it replaces - `beginDokployImport` runs the same
 * `assertImportGate` - and it returns as soon as the plan is durable, not when
 * the migration is done. The tab is free from that moment.
 */
export async function startDokployRun(input: StartRunInput): Promise<string> {
  const { teamId } = await assertImportGate();
  if (input.targets.length === 0)
    throw new Error("Nothing is selected, so there is nothing to migrate.");

  const runId = await beginDokployImport({
    url: input.url,
    orgName: input.orgName ?? null,
  });
  const { currentIdentity } = await import("../auth/request-context");
  const { getCurrentUser } = await import("../auth");
  const userId =
    currentIdentity()?.userId ?? (await getCurrentUser())?.id ?? null;

  await getDb().transaction(async (tx) => {
    await tx
      .update(runsTable)
      .set({
        apiKeyEnc: encryptSecret(input.apiKey),
        allowPrivate: input.allowPrivate,
        actorUserId: userId,
        totalSteps: input.targets.length,
        doneSteps: 0,
        phase: "config",
        stopRequested: false,
        stepLabel: input.targets[0]?.projectName ?? null,
      })
      .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
    for (const t of input.targets)
      await tx.insert(targetsTable).values({
        id: newId("dtgt"),
        runId,
        projectId: t.projectId,
        projectName: t.projectName,
        serviceId: t.serviceId,
        serverId: t.serverId ?? null,
        buildServerId: t.buildServerId ?? null,
        exposedPort: t.exposedPort ?? null,
        exposedPortSet: t.exposedPortSet ?? false,
      });
    for (const s of input.servers)
      if (s.to)
        await tx
          .insert(runServersTable)
          .values({ runId, fromId: s.from, toId: s.to })
          .onConflictDoNothing();
  });

  publishMigrationChanged();
  // Do not await: the caller is a mutation, and the run is now durable enough to
  // be finished by any tick, including one in another process.
  void runMigrationTick().catch((e) =>
    console.error("[migration] first tick failed:", e),
  );
  return runId;
}

/** Ask a run to stop. It notices between steps; nothing is abandoned mid-call. */
export async function requestStopDokployRun(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  const [row] = await getDb()
    .update(runsTable)
    .set({ stopRequested: true })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)))
    .returning({
      heartbeatAt: runsTable.heartbeatAt,
      status: runsTable.status,
    });
  publishMigrationChanged();
  if (!row || row.status !== "running") return;

  // Nobody is driving it. The flag alone would leave the row `running` forever -
  // which is what a run started by an old client, or one whose runner died
  // without a successor, looks like. Closing it here is the same call the runner
  // would make; it is only ever reached when no runner will.
  const beatAt = row.heartbeatAt ? Date.parse(row.heartbeatAt) : 0;
  if (Date.now() - beatAt < STALE_MS) return;
  await stopDokployImport(runId);
  await getDb()
    .update(runsTable)
    .set({ apiKeyEnc: null, runnerOwner: null, phase: "done" })
    .where(eq(runsTable.id, runId));
  publishMigrationChanged();
}

/**
 * One pass over whatever is running. Never throws: one broken migration must not
 * take the timer down with it.
 */
export async function runMigrationTick(): Promise<void> {
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

/** Take one run, if nobody else has it, and see it through. */
async function drive(row: RunRow): Promise<void> {
  if (!(await acquireLease(leaseFor(row.id), owner, new Date(), STALE_MS)))
    return;
  inflight.add(row.id);
  try {
    await advance(row);
  } catch (e) {
    console.error("[migration] run", row.id, "failed:", e);
    await failRun(row, e instanceof Error ? e.message : String(e));
  } finally {
    inflight.delete(row.id);
    await releaseLease(leaseFor(row.id), owner).catch(() => {});
  }
}

/** Start the timer that keeps migrations moving. Called once, at boot. */
export function startMigrationRunner(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runMigrationTick();
  }, IDLE_TICK_MS);
  timer.unref?.();
  void runMigrationTick();
}

/**
 * Hand the lease back on SIGTERM/SIGINT, so the next control plane picks the
 * migration up on its first tick instead of waiting out the staleness window.
 *
 * The four schedulers have always done this; the runner was added later and was
 * not on the list, which is how a restart during a migration became a migration
 * that stayed still with nothing on screen to say why.
 */
export async function releaseMigrationRunnerLease(): Promise<void> {
  for (const runId of inflight)
    await releaseLease(leaseFor(runId), owner).catch(() => {});
}

/** Test seam: stop the timer so a suite does not tick under itself. */
export function stopMigrationRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

type RunRow = typeof runsTable.$inferSelect;

/** Claim the run and keep claiming it: a long step must not look abandoned.
 *
 *  Both claims, in one call. The lease renewal rides along because the two
 *  staleness windows have to move together: a run whose heartbeat is fresh while
 *  its runner's lease has gone stale is a run two control planes would drive. */
async function beat(runId: string): Promise<void> {
  await acquireLease(leaseFor(runId), owner, new Date(), STALE_MS);
  await getDb()
    .update(runsTable)
    .set({ runnerOwner: owner, heartbeatAt: nowIso() })
    .where(eq(runsTable.id, runId));
}

async function setProgress(
  runId: string,
  patch: { doneSteps?: number; stepLabel?: string | null; phase?: string },
): Promise<void> {
  await getDb().update(runsTable).set(patch).where(eq(runsTable.id, runId));
  publishMigrationChanged();
}

/**
 * Close a run as failed, say why, forget the key - and take it back out.
 *
 * The key goes on EVERY door out of `running`, not only this one: a run that
 * ended has no further use for it, and a credential kept past its use is a
 * credential nobody remembers is there.
 *
 * The undo is not an extra kindness, it is the same rule a Stop obeys: a run
 * that broke on project four of seven leaves exactly the debris a stopped one
 * does, and half a copied volume is worse than none. There used to be a panel
 * offering to keep it; there is not any more, so leaving the debris would leave
 * it with nothing to remove it. A migration either lands whole or leaves
 * nothing.
 *
 * `error` survives the undo (the revert writes `status`, never the message), so
 * the wizard and History still say WHY it stopped.
 */
async function failRun(row: RunRow, why: string): Promise<void> {
  await getDb()
    .update(runsTable)
    .set({
      status: "failed",
      error: why,
      finishedAt: nowIso(),
      apiKeyEnc: null,
      runnerOwner: null,
      phase: "done",
    })
    .where(and(eq(runsTable.id, row.id), eq(runsTable.status, "running")));
  publishMigrationChanged();

  // Under the actor, like everything else the runner does - the undo is a stack
  // of ordinary capability-gated deletes. A run too old to carry an actor keeps
  // the old behaviour: it stays where it stopped rather than being deleted by
  // nobody.
  if (!row.actorUserId) return;
  try {
    await runWithIdentity({ userId: row.actorUserId, teamId: row.teamId }, () =>
      undoDokployImport(row.id),
    );
  } catch (e) {
    console.error("[migration] undo after failure", row.id, "failed:", e);
  }
}

async function credentialFor(row: RunRow): Promise<RunCredential> {
  if (!row.apiKeyEnc)
    throw new Error(
      "This run has no stored key, so Deplo cannot carry on with it. Start it again.",
    );
  return {
    url: row.sourceUrl,
    apiKey: decryptSecretOrThrow(row.apiKeyEnc, "the Dokploy API key"),
    allowPrivate: row.allowPrivate,
  };
}

/** Everything one run needs, done under the identity of whoever started it. */
async function advance(row: RunRow): Promise<void> {
  if (!row.actorUserId)
    throw new Error("This run was started before Deplo could resume one.");
  await beat(row.id);
  // The steps beat between themselves, and one step can be a 900 MB volume
  // crossing two hosts - minutes in which nothing beat at all, so the run and
  // the lease both went cold under a runner that was working perfectly. The
  // timer is what makes a long step look alive; `ticking` keeps the idle tick
  // out of here, so nothing else was going to.
  const heart = setInterval(() => {
    void beat(row.id).catch(() => {});
    // And it carries the STOP inwards. `stopped()` is read between steps, but a
    // step is one service and one service can be an hour of volume - which is
    // how a stopped run went on copying into apps its own undo had already
    // deleted. The flag reaches the stream here, within a beat of being set,
    // whichever control plane set it.
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

/** Is this run still wanted? A pure read - it is called from the heartbeat, which
 *  must never undo anything by itself. */
async function stopWanted(runId: string): Promise<boolean> {
  const [r] = await getDb()
    .select({ stop: runsTable.stopRequested, status: runsTable.status })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  return !r || r.status !== "running" || r.stop;
}

/** Has somebody asked it to stop? Read fresh, between steps, every time - and if
 *  they have, this is where the migration is taken back out. */
async function stopped(runId: string): Promise<boolean> {
  const [r] = await getDb()
    .select({ stop: runsTable.stopRequested, status: runsTable.status })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  if (!r) return true;
  if (r.status !== "running") return true;
  if (!r.stop) return false;
  // Total: apps, databases, projects, variables, and Deplo's agent off the
  // source machines. See `stopDokployImport`.
  await stopDokployImport(runId);
  await getDb()
    .update(runsTable)
    .set({ apiKeyEnc: null, runnerOwner: null, phase: "done" })
    .where(eq(runsTable.id, runId));
  publishMigrationChanged();
  return true;
}

/* ------------------------------------------------------------------ */
/* The two phases                                                      */
/* ------------------------------------------------------------------ */

/**
 * Nothing is created until every machine this run reads from ANSWERS.
 *
 * The install step proved it once, and that proof has an age: a run resumed
 * after a control-plane restart may be hours old. It costs one Hello per machine
 * and it is the last moment a refusal is free.
 */
async function assertMachinesAnswer(row: RunRow): Promise<void> {
  const ids = new Set(
    (
      await getDb()
        .select({ to: runServersTable.toId })
        .from(runServersTable)
        .where(eq(runServersTable.runId, row.id))
    ).map((r) => r.to),
  );
  if (ids.size === 0) return;
  const known = new Map(
    (await listServersForTeam(row.teamId)).map((s) => [s.id, s.name]),
  );
  for (const id of ids) {
    const server = await checkServerHealth(id, { force: true });
    if (server.status !== "online")
      throw new Error(
        `${known.get(id) ?? "A machine"} is not answering: ${
          server.statusMessage || "no answer"
        }. Nothing was created.`,
      );
  }
}

interface ProjectGroup {
  projectId: string;
  projectName: string;
  rowIds: string[];
  serviceIds: string[];
  placements: ServicePlacement[];
}

/** What is still to do, in the order it was chosen, grouped by project. */
async function pendingGroups(runId: string): Promise<ProjectGroup[]> {
  const rows = await getDb()
    .select()
    .from(targetsTable)
    .where(
      and(eq(targetsTable.runId, runId), eq(targetsTable.state, "pending")),
    )
    .orderBy(asc(targetsTable.seq));
  const byProject = new Map<string, ProjectGroup>();
  for (const r of rows) {
    let g = byProject.get(r.projectId);
    if (!g) {
      g = {
        projectId: r.projectId,
        projectName: r.projectName,
        rowIds: [],
        serviceIds: [],
        placements: [],
      };
      byProject.set(r.projectId, g);
    }
    g.rowIds.push(r.id);
    g.serviceIds.push(r.serviceId);
    // Only a placement with a server is one: `serverId` is what a placement IS,
    // and the per-service map is optional - anything without one falls back to
    // the machine-wide choice in `dokploy_run_servers`.
    if (r.serverId)
      g.placements.push({
        serviceId: r.serviceId,
        serverId: r.serverId,
        buildServerId: r.buildServerId,
        // Absent unless the review actually decided it - see `exposedPortSet`.
        ...(r.exposedPortSet ? { exposedPort: r.exposedPort } : {}),
      });
  }
  return [...byProject.values()];
}

async function markTargets(ids: string[], state: string): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .update(targetsTable)
    .set({ state })
    .where(sql`${targetsTable.id} in ${ids}`);
}

async function runConfigPhase(row: RunRow, c: RunCredential): Promise<void> {
  await assertMachinesAnswer(row);

  const servers = (
    await getDb()
      .select()
      .from(runServersTable)
      .where(eq(runServersTable.runId, row.id))
  ).map((r) => ({ from: r.fromId, to: r.toId }));

  // Two in a row is the line. One project failing is a hiccup; two is the
  // situation, and working through eight of them to arrive at a report where
  // nothing came across is the thing this must never do.
  let inARow = 0;
  let done = row.doneSteps;

  for (const g of await pendingGroups(row.id)) {
    if (await stopped(row.id)) return;
    await beat(row.id);
    await setProgress(row.id, { stepLabel: g.projectName });
    try {
      await importDokployProject({
        url: c.url,
        apiKey: c.apiKey,
        allowPrivate: c.allowPrivate,
        runId: row.id,
        projectId: g.projectId,
        servers,
        serviceIds: g.serviceIds,
        placements: g.placements,
      });
      await markTargets(g.rowIds, "done");
      inARow = 0;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await markTargets(g.rowIds, "failed");
      await appendRunItem(row.id, {
        path: g.projectName,
        sourceKind: "project",
        sourceName: g.projectName,
        outcome: "failed",
        message: why,
      });
      if (++inARow >= 2)
        throw new Error(
          `Two projects in a row failed the same way, so Deplo stopped. Last error: ${why}`,
        );
    }
    done += g.rowIds.length;
    await setProgress(row.id, { doneSteps: done });
  }

  // Read the RUN's own counter rather than a local tally: a resumed run did some
  // of its creating in an earlier process, and a local count would call that
  // nothing.
  const [after] = await getDb()
    .select({ created: runsTable.created })
    .from(runsTable)
    .where(eq(runsTable.id, row.id))
    .limit(1);
  if ((after?.created ?? 0) === 0)
    throw new Error(
      "Nothing came across, so Deplo stopped before touching any data. The report says what refused.",
    );

  await setProgress(row.id, {
    phase: "data",
    doneSteps: 0,
    stepLabel: "Reading the volumes",
  });
}

async function runDataPhase(row: RunRow, c: RunCredential): Promise<void> {
  await beat(row.id);
  const planned = await planDokployDataMove({
    url: c.url,
    apiKey: c.apiKey,
    allowPrivate: c.allowPrivate,
    runId: row.id,
  });
  // Every reason a service will not have its data copied is SAID. These notes
  // are the whole value of the report.
  for (const d of planned)
    for (const note of d.notes)
      await appendRunItem(row.id, {
        path: d.path,
        sourceKind: "data",
        sourceName: d.sourceName,
        outcome: "manual",
        message: note,
      });

  const movable = planned.filter((d) => d.volumes.length > 0);
  const unreachable = movable.filter((d) => !d.sourceReachable);
  if (unreachable.length > 0)
    throw new Error(
      `Deplo cannot reach the machine ${unreachable[0].sourceName}'s data is on, so no data was copied and nothing was stopped on Dokploy.`,
    );

  await getDb()
    .update(runsTable)
    .set({ totalSteps: movable.length, doneSteps: 0 })
    .where(eq(runsTable.id, row.id));

  for (const [i, d] of movable.entries()) {
    if (await stopped(row.id)) return;
    await beat(row.id);
    await setProgress(row.id, { doneSteps: i, stepLabel: d.sourceName });
    // The bytes, while they cross. One service is ONE step here, so without this
    // a 15 GB volume is an hour of a progress line that never changes - which is
    // indistinguishable from a run that died, and got read as one.
    let copied = 0;
    let shownAt = 0;
    let res: Awaited<ReturnType<typeof moveDokployServiceData>>;
    try {
      res = await moveDokployServiceData({
        url: c.url,
        apiKey: c.apiKey,
        allowPrivate: c.allowPrivate,
        runId: row.id,
        sourceKind: d.sourceKind,
        sourceId: d.sourceId,
        onBytes: (chunk) => {
          copied += chunk;
          // Throttled, because the relay hands us a chunk roughly every megabyte
          // and this is a label, not a byte log. Fire-and-forget for the same
          // reason: the copy does not wait on its own progress line.
          const now = Date.now();
          if (now - shownAt < PROGRESS_MS) return;
          shownAt = now;
          void setProgress(row.id, {
            stepLabel: `${d.sourceName} - ${formatBytes(copied)}`,
          }).catch(() => {});
        },
      });
    } catch (e) {
      // The copy was cut by a Stop, not by a fault. `stopped()` is what undoes
      // the run; there is nothing to report and nothing left to copy.
      if (isCopyAborted(e)) {
        await stopped(row.id);
        return;
      }
      throw e;
    }
    // A failed VOLUME is a line in the report. A failed MACHINE is the end: every
    // service after this one is on it, and each gets stopped over there before
    // its copy is tried.
    if (res.sourceGone)
      throw new Error(
        `Lost the connection to the machine ${d.sourceName}'s data is on. Stopped there, and nothing after it was touched.`,
      );
  }

  await setProgress(row.id, { doneSteps: movable.length, stepLabel: null });
  await finishDokployImport(row.id);
  await getDb()
    .update(runsTable)
    .set({ apiKeyEnc: null, runnerOwner: null, phase: "done" })
    .where(eq(runsTable.id, row.id));
  publishMigrationChanged();
}
