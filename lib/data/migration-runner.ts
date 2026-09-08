import "server-only";

import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  migrationRuns as runsTable,
  migrationRunServers as runServersTable,
  migrationRunTargets as targetsTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { MIGRATION_HEARTBEAT_STALE_MS } from "../types";
import { formatBytes } from "../utils";
import { encryptSecret, decryptSecretOrThrow } from "../crypto";
import { isMigrationPlatform, sourceClient } from "../migration/source";
import type { MigrationPlatform, SourceCredential } from "../migration/source";
import { normalizeSourceBaseUrl } from "../migration/transport";
import { holdsTeamWideCapability } from "../membership";
import { createTeam } from "./teams";
import { runWithIdentity } from "../auth/request-context";
import { acquireLease, releaseLease } from "../backups/lease";
import { publishMigrationChanged } from "../graphql/pubsub";
import type { ServicePlacement } from "./migration-import";
import {
  appendRunItem,
  assertImportGate,
  beginMigration,
  cancelQueuedRuns,
  credentialFor as connectCredential,
  finishMigration,
  handOverMigrationSources,
  importMigrationProject,
  importRunMembers,
  releaseMigrating,
  removeSourcesOfRun,
  stopMigration,
  undoMigration,
} from "./migration-import";
import {
  abortRunCopy,
  assertMigrationMachinesReady,
  moveMigrationServiceData,
  planMigrationDataMove,
  markRunTargetsUncopied,
  restartSourcesStoppedByRun,
  type DataMoveService,
} from "./migration-data";
import { dataAlreadyCopiedInto, markDataCopyFailed } from "./data-copy";
import { isCopyAborted } from "./volume-migration";
import { checkServerHealth } from "./server-health";
import { listServersForTeam } from "./servers";

/**
 * The import loop, moved out of the browser tab. A background job with its own
 * capability checks would be a second authorization model, and this repo has one.
 */

/**
 * One lease PER RUN, not one for the instance. Per run, the lease means what a
 * lease is for - two processes must not drive the SAME run - and it cannot mean
 * anything else.
 */
export const leaseFor = (runId: string) => `dokploy-migration:${runId}`;
/**
 * A heartbeat older than this is a control plane that died; take the run over.
 */
const STALE_MS = MIGRATION_HEARTBEAT_STALE_MS;
/** How often the tick runs when nothing is going on. */
const IDLE_TICK_MS = 15_000;
/** How often a copy in flight refreshes its byte count on the progress line. */
const PROGRESS_MS = 1_000;

const owner = `${process.pid}-${newId("run")}`;

/** Runs this process is driving right now. One `advance` per run, never two -
 *  and a long one never keeps the tick from picking up a different run. */
const inflight = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/** What a run needs to talk to its panel, decrypted for the length of one step. */
interface RunCredential {
  /**
   * Read from the run's row, never re-detected: a resume happens hours later, and
   * a detection that answered differently would point the data cutover at the
   * wrong API.
   */
  kind: MigrationPlatform;
  url: string;
  apiKey: string;
}

export interface StartRunInput {
  url: string;
  apiKey: string;
  /** Which product the scan identified. Recorded once, never re-detected; absent
   *  only from a caller that predates the second platform. */
  kind?: MigrationPlatform;
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
  /**
   * Another team of the SAME panel is queued behind this run, so the agents on
   * the source machines are not this run's to remove - the next team reads the
   * same disks. See `migration_runs.keep_sources`.
   *
   * Derived from `queued` when that is given: the last team of a walk is the one
   * that clears them, and nothing outside this function decides which that is.
   */
  keepSources?: boolean;
  /**
   * The teams of the same panel to bring over after this one, in order. They are
   * written down now and started by the control plane as each turn ends - the
   * queue used to live in the browser tab, so closing it lost every team but the
   * first.
   */
  queued?: QueuedTeamInput[];
}

/** One more team of the same panel, waiting its turn. */
export interface QueuedTeamInput {
  /** That team's own token: a key reads exactly one team on both products. */
  apiKey: string;
  orgName?: string | null;
  /** The Deplo team it lands in, when it exists already. */
  teamId?: string | null;
  /** Otherwise the team made for it, right now, so its turn has somewhere to go. */
  newTeamName?: string | null;
  newTeamImage?: string | null;
  targets: StartRunInput["targets"];
  servers: { from: string; to: string }[];
}

/**
 * Open a run, write down everything needed to finish it, and start it moving.
 */
export async function startMigrationRun(input: StartRunInput): Promise<string> {
  const { teamId } = await assertImportGate();
  if (input.targets.length === 0)
    throw new Error("Nothing is selected, so there is nothing to migrate.");

  // Which panel this is, and whether it answers at all, BEFORE a run exists.
  // Both were the wizard's alone: a Coolify migration driven from the API ran the
  // Dokploy client against it and died on its first call, inside a run that had
  // already been created.
  const c = await connectCredential(input);
  const client = sourceClient(c);
  // The scan asserts the token's scope; a run driven from the API skipped it and
  // imported every variable as KEY= (ADR-0026).
  await client.assertReadable();
  await client.listProjects();
  // And the MACHINES, which is the half the panel answering says nothing about.
  await assertMigrationMachinesReady(
    c,
    input.targets.map((t) => t.serviceId),
  );

  // Every queued token is proved HERE, before anything is created: a bad key on
  // the third team used to surface forty minutes into the first one's copy.
  const queued = input.queued ?? [];
  const queuedCreds: SourceCredential[] = [];
  for (const q of queued) {
    const qc = await connectCredential({
      url: input.url,
      apiKey: q.apiKey,
      kind: c.kind,
    });
    const qclient = sourceClient(qc);
    await qclient.assertReadable();
    await qclient.listProjects();
    queuedCreds.push(qc);
    if (q.targets.length === 0)
      throw new Error("A queued team has nothing selected to migrate.");
  }

  const runId = await beginMigration({
    url: input.url,
    orgName: input.orgName ?? null,
    kind: c.kind,
    // A queue is the fact: a caller that says otherwise while queueing teams
    // would have the first run take the agents off machines the rest still read.
    keepSources: queued.length > 0 || (input.keepSources ?? false),
  });
  const { currentIdentity } = await import("../auth/request-context");
  const { getCurrentUser } = await import("../auth");
  const me = await getCurrentUser();
  const userId = currentIdentity()?.userId ?? me?.id ?? null;
  const actorName = me?.name ?? "someone";

  await getDb().transaction(async (tx) => {
    await tx
      .update(runsTable)
      .set({
        apiKeyEnc: encryptSecret(input.apiKey),
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

  for (const [i, q] of queued.entries())
    await enqueueTeam({
      sessionId: runId,
      url: input.url,
      credential: queuedCreds[i],
      team: q,
      actor: { name: actorName, userId },
      // The LAST team of the walk is the one that takes Deplo's agents back off
      // the source machines; everyone before it leaves them for the next turn.
      keepSources: i < queued.length - 1,
    });

  publishMigrationChanged();
  // Do not await: the caller is a mutation, and the run is now durable enough to
  // be finished by any tick, including one in another process.
  void runMigrationTick().catch((e) =>
    console.error("[migration] first tick failed:", e),
  );
  return runId;
}

/**
 * Write down one team that is still to come: its own token, where it lands, and
 * everything the review chose for it. Nothing of it runs until the turn before it
 * ends - see {@link promoteQueuedRuns}.
 */
async function enqueueTeam(opts: {
  sessionId: string;
  url: string;
  credential: SourceCredential;
  team: QueuedTeamInput;
  actor: { name: string; userId: string | null };
  keepSources: boolean;
}): Promise<string> {
  const { team } = opts;
  let teamId = team.teamId?.trim() || "";
  if (teamId) {
    if (!(await holdsTeamWideCapability(teamId, "create_projects")))
      throw new Error("You cannot create projects in one of the teams chosen.");
  } else {
    const name = team.newTeamName?.trim() || team.orgName?.trim() || "";
    if (!name) throw new Error("A queued team needs a name to land under.");
    // Made now rather than when its turn comes: a team that does not exist has
    // nowhere to hang the run row, and the review already said it would be made.
    teamId = (await createTeam({ name, image: team.newTeamImage ?? null })).id;
  }
  const id = newId("dimp");
  const now = nowIso();
  await getDb().transaction(async (tx) => {
    await tx.insert(runsTable).values({
      id,
      teamId,
      sourceUrl: normalizeSourceBaseUrl(opts.url),
      platform: opts.credential.kind,
      orgName: team.orgName?.trim() || null,
      actor: opts.actor.name,
      actorUserId: opts.actor.userId,
      status: "queued",
      created: 0,
      skipped: 0,
      failed: 0,
      manual: 0,
      error: null,
      startedAt: now,
      finishedAt: null,
      apiKeyEnc: encryptSecret(team.apiKey),
      totalSteps: team.targets.length,
      doneSteps: 0,
      phase: "config",
      keepSources: opts.keepSources,
      sessionId: opts.sessionId,
    });
    for (const t of team.targets)
      await tx.insert(targetsTable).values({
        id: newId("dtgt"),
        runId: id,
        projectId: t.projectId,
        projectName: t.projectName,
        serviceId: t.serviceId,
        serverId: t.serverId ?? null,
        buildServerId: t.buildServerId ?? null,
        exposedPort: t.exposedPort ?? null,
        exposedPortSet: t.exposedPortSet ?? false,
      });
    for (const s of team.servers)
      if (s.to)
        await tx
          .insert(runServersTable)
          .values({ runId: id, fromId: s.from, toId: s.to })
          .onConflictDoNothing();
  });
  return id;
}

/** Ask a run to stop. It notices between steps; nothing is abandoned mid-call. */
export async function requestStopMigrationRun(runId: string): Promise<void> {
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
  // which is what a run started by an old client, or one whose runner died without a
  // successor, looks like.
  const beatAt = row.heartbeatAt ? Date.parse(row.heartbeatAt) : 0;
  if (Date.now() - beatAt < STALE_MS) return;
  await stopRun(runId);
}

/**
 * One pass over whatever is running. Never throws: one broken migration must not
 * take the timer down with it.
 */
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

/**
 * The turn AFTER: every session whose team has finished and whose next team has
 * not started. Idempotent and driven off the rows alone, so a control plane that
 * died mid-walk picks the queue up on its first tick.
 */
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

/**
 * Take one run, if nobody else has it, and see it through. The claim is marked
 * BEFORE the first `await`, and that ordering is the whole guard.
 */
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

/** Runs whose lease another control plane took from under this one. */
const lostLeases = new Set<string>();

/** Thrown out of a step when the lease is gone: the other owner finishes the run. */
class LeaseLost extends Error {
  constructor(runId: string) {
    super(`another control plane took over migration ${runId}`);
  }
}

/**
 * Claim the run and keep claiming it: a long step must not look abandoned.
 */
async function beat(runId: string): Promise<void> {
  // The lease is the run: another control plane that took it is copying into
  // the same volumes, so this one cuts its copy and writes nothing more.
  if (!(await acquireLease(leaseFor(runId), owner, new Date(), STALE_MS))) {
    lostLeases.add(runId);
    abortRunCopy(runId);
    throw new Error("lease lost");
  }
  await getDb()
    .update(runsTable)
    .set({ runnerOwner: owner, heartbeatAt: nowIso() })
    .where(eq(runsTable.id, runId));
  // And it is PUBLISHED, because the panel's only proof that somebody is driving this
  // run is a heartbeat it can see.
  publishMigrationChanged();
}

async function setProgress(
  runId: string,
  patch: { doneSteps?: number; stepLabel?: string | null; phase?: string },
): Promise<void> {
  await getDb().update(runsTable).set(patch).where(eq(runsTable.id, runId));
  publishMigrationChanged();
}

/**
 * Close a run as failed, say why, forget the key - and take it back out. There
 * used to be a panel offering to keep it; there is not any more, so leaving the
 * debris would leave it with nothing to remove it.
 *
 * Debris is a CONFIG phase that could not finish. Once the data phase has begun,
 * everything the run created is the user's new infrastructure: undoing it over a
 * volume that would not copy left the old platform stopped and the new one empty.
 */
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

  // Whatever it did, the run is over - so everything it created is the team's
  // again. Without this the apps stayed frozen behind "still being brought over
  // by a migration" with no migration left to finish, and only a restart of the
  // control plane ever let them go.
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

  // Under the actor, like everything else the runner does - the undo is a stack of
  // ordinary capability-gated deletes.
  if (!row.actorUserId) return;
  try {
    await runWithIdentity({ userId: row.actorUserId, teamId: row.teamId }, () =>
      // Not forced: data that did not copy is still over there, and the agent is
      // the only way to fetch it. The next attempt needs the machine readable.
      undoMigration(row.id, { forceSourceRemoval: false }),
    );
  } catch (e) {
    console.error("[migration] undo after failure", row.id, "failed:", e);
  }
}

/** The source product's name, for the `{panel}` a mapper's note carries. */
function panelNameFor(row: { platform: string }): string {
  return row.platform === "coolify" ? "Coolify" : "Dokploy";
}

async function credentialFor(row: RunRow): Promise<RunCredential> {
  if (!row.apiKeyEnc)
    throw new Error(
      "This run has no stored key, so Deplo cannot carry on with it. Start it again.",
    );
  return {
    kind: isMigrationPlatform(row.platform) ? row.platform : "dokploy",
    url: row.sourceUrl,
    apiKey: decryptSecretOrThrow(row.apiKeyEnc, "the panel's API token"),
  };
}

/** Everything one run needs, done under the identity of whoever started it. */
async function advance(row: RunRow): Promise<void> {
  if (!row.actorUserId)
    throw new Error("This run was started before Deplo could resume one.");
  await beat(row.id);
  // The steps beat between themselves, and one step can be a 900 MB volume crossing
  // two hosts - minutes in which nothing beat at all, so the run and the lease both
  // went cold under a runner that was working perfectly.
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
  await stopRun(runId);
  return true;
}

/**
 * A Stop, honoured. In the config phase it is total - apps, databases, projects,
 * variables, and Deplo's agent off the source machines (see `stopMigration`). In
 * the DATA phase what was created is the person's new infrastructure: it is
 * kept, every service whose data is not here is marked so, the agents stay for
 * the next attempt, and what this run stopped on the panel is started again.
 */
async function stopRun(runId: string): Promise<void> {
  const [row] = await getDb()
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  if (row && row.phase === "data") {
    await getDb()
      .update(runsTable)
      // Seen: the person stopped it themselves, and an unseen stop reopened the
      // wizard on it - toast included - every time they came back.
      .set({ status: "stopped", finishedAt: nowIso(), reportSeenAt: nowIso() })
      .where(and(eq(runsTable.id, runId), eq(runsTable.status, "running")));
    await releaseMigrating(runId);
    await markRunTargetsUncopied(runId, "the migration was stopped").catch(
      () => 0,
    );
    let restarted = { restarted: 0, left: [] as string[] };
    try {
      const c = await credentialFor(row);
      restarted = await restartSourcesStoppedByRun(runId, {
        kind: c.kind,
        baseUrl: c.url,
        apiKey: c.apiKey,
      });
    } catch (e) {
      restarted.left.push(e instanceof Error ? e.message : String(e));
    }
    await appendRunItem(runId, panelNameFor(row), {
      path: "Migration",
      sourceKind: "run",
      sourceName: "Migration",
      outcome: "manual",
      message: `Stopped during the data step. Everything created here was kept; the lines above name every service whose data is not here yet. ${restarted.restarted > 0 ? `${restarted.restarted} service(s) were started again on {panel}.` : ""}${restarted.left.length > 0 ? ` Still stopped on {panel}: ${restarted.left.join("; ")}.` : ""} Deplo's agent stays on the source machines so the copy can run again.`,
    });
  } else {
    await stopMigration(runId);
  }
  await getDb()
    .update(runsTable)
    .set({ apiKeyEnc: null, runnerOwner: null, phase: "done" })
    .where(eq(runsTable.id, runId));
  publishMigrationChanged();
}

/* ------------------------------------------------------------------ */
/* The two phases                                                      */
/* ------------------------------------------------------------------ */

/**
 * Nothing is created until every machine this run reads from ANSWERS. The install
 * step proved it once, and that proof has an age: a run resumed after a
 * control-plane restart may be hours old.
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

/**
 * A project with nothing IN it on the panel. Left out silently, it read as a
 * project that vanished between the scan and the report - and one with services
 * nobody ticked stays silent, because that one was a choice.
 */
async function noteEmptyProjects(row: RunRow, c: RunCredential): Promise<void> {
  let projects;
  try {
    projects = await sourceClient(await connectCredential(c)).listProjects();
  } catch {
    return;
  }
  for (const p of projects) {
    const holds = (e: {
      applications?: unknown[] | null;
      compose?: unknown[] | null;
      postgres?: unknown[] | null;
      mysql?: unknown[] | null;
      mariadb?: unknown[] | null;
      mongo?: unknown[] | null;
      redis?: unknown[] | null;
      libsql?: unknown[] | null;
      clickhouse?: unknown[] | null;
    }) =>
      [
        e.applications,
        e.compose,
        e.postgres,
        e.mysql,
        e.mariadb,
        e.mongo,
        e.redis,
        e.libsql,
        e.clickhouse,
      ].some((l) => (l ?? []).length > 0);
    if ((p.environments ?? []).some(holds) || holds(p)) continue;
    await appendRunItem(row.id, panelNameFor(row), {
      path: p.name,
      sourceKind: "project",
      sourceName: p.name,
      sourceId: p.projectId,
      outcome: "skipped",
      message:
        "Nothing is in this project on {panel}, so there was nothing to bring across.",
    });
  }
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
    // the machine-wide choice in `migration_run_servers`.
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

  await noteEmptyProjects(row, c);
  // A key belongs to ONE of them, and neither panel's API will list the others -
  // so a second tenant's whole estate is simply absent from a report that reads
  // complete. Said once, where "what did and did not come across" is answered.
  await appendRunItem(row.id, panelNameFor(row), {
    path: "{panel}",
    sourceKind: "organization",
    sourceName: row.orgName || "{panel}",
    outcome: "skipped",
    message:
      "An API key belongs to one organization, so this import covers that one only. Anything under another organization on {panel} needs a second import with a key from it.",
  });

  for (const g of await pendingGroups(row.id)) {
    if (await stopped(row.id)) return;
    await beat(row.id);
    await setProgress(row.id, { stepLabel: g.projectName });
    try {
      await importMigrationProject({
        url: c.url,
        apiKey: c.apiKey,
        kind: c.kind,
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
      await appendRunItem(row.id, panelNameFor(row), {
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
    .select({ created: runsTable.created, skipped: runsTable.skipped })
    .from(runsTable)
    .where(eq(runsTable.id, row.id))
    .limit(1);
  // A skip is a service that is ALREADY here, which is what running the import a
  // second time looks like - and that is the way to bring newer data across. Read
  // as nothing, it reverted the run and took the agent off the source with it.
  if ((after?.created ?? 0) === 0 && (after?.skipped ?? 0) === 0)
    throw new Error(
      "Nothing came across, so Deplo stopped before touching any data. The report says what refused.",
    );

  await setProgress(row.id, {
    phase: "data",
    doneSteps: 0,
    stepLabel: "Reading the volumes",
  });
}

/**
 * Say, on the resource itself and in the report, that a service's data never came
 * across. A migration that stops part way used to leave every service it had not
 * reached running on a brand-new empty volume, indistinguishable from one that
 * worked - which is the shape data loss takes when nobody is told.
 */
async function markUncopied(
  row: RunRow,
  services: DataMoveService[],
  why: string,
): Promise<void> {
  for (const d of services) {
    // A retry of a service this run ALREADY copied says nothing about the data:
    // the bytes are in the volume, and the row must not be blocked over how the
    // second attempt went.
    const landed = await dataAlreadyCopiedInto(row.id, d.targetId);
    const reason = `${d.sourceName}'s data was not copied: ${why}`;
    if (!landed)
      await markDataCopyFailed({ kind: d.targetKind, id: d.targetId }, reason);
    await appendRunItem(row.id, panelNameFor(row), {
      path: d.path,
      sourceKind: d.sourceKind,
      sourceId: d.sourceId,
      sourceName: d.sourceName,
      outcome: landed ? "manual" : "failed",
      targetKind: d.targetKind,
      targetId: d.targetId,
      message: landed
        ? `${d.sourceName} was read again and ${why} - its data had already been copied into ${d.targetName}, which keeps it.`
        : `${reason}. ${d.targetName} is running on the empty storage Deplo created for it - bring the data over before anyone uses it, or choose "Deploy anyway" to accept starting without it.`,
    });
  }
}

/** Under this, a copy is walking into a disk that cannot hold what it carries. */
const DISK_FLOOR_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_FLOOR_RATIO = 0.1;

/**
 * The machine about to RECEIVE the bytes, before any of them move. The takeover
 * has asked this since it existed; an external migration never did, and a copy
 * into a disk at 93% just failed part way with nothing having said why.
 */
async function noteTightDisks(row: RunRow, serverIds: string[]): Promise<void> {
  const { fetchHostInfo } = await import("../infra/agent-client");
  const { formatBytes } = await import("../utils");
  for (const id of [...new Set(serverIds)]) {
    let info;
    try {
      info = await fetchHostInfo(id);
    } catch {
      continue;
    }
    const total = info.diskTotalBytes;
    const free = Math.max(0, total - info.diskUsedBytes);
    if (total <= 0) continue;
    if (free >= DISK_FLOOR_BYTES && free / total >= DISK_FLOOR_RATIO) continue;
    await appendRunItem(row.id, panelNameFor(row), {
      path: "Data",
      sourceKind: "data",
      sourceName: "disk",
      outcome: "manual",
      message: `The machine receiving this data has ${formatBytes(free)} free of ${formatBytes(total)}. A copy writes a second copy of everything before the old one goes, so free some room first.`,
    });
  }
}

async function runDataPhase(row: RunRow, c: RunCredential): Promise<void> {
  await beat(row.id);
  const planned = await planMigrationDataMove({
    url: c.url,
    apiKey: c.apiKey,
    kind: c.kind,
    runId: row.id,
  });
  // Every reason a service will not have its data copied is SAID. These notes
  // are the whole value of the report.
  for (const d of planned)
    for (const note of d.notes)
      await appendRunItem(row.id, panelNameFor(row), {
        path: d.path,
        sourceKind: "data",
        sourceName: d.sourceName,
        outcome: "manual",
        message: note,
      });

  const planning = planned.filter((d) => d.volumes.length > 0);
  await noteTightDisks(
    row,
    planning.map((d) => d.targetServerId).filter((id) => id != null),
  );
  const unreachable = planning.filter((d) => !d.sourceReachable);
  const movable = planning.filter((d) => d.sourceReachable);
  if (unreachable.length > 0) {
    // Named, and then STEPPED OVER. One machine nobody can reach is not a reason
    // to leave the services on the machines that do answer sitting on empty
    // storage - each one that cannot move says so on its own line.
    await markUncopied(
      row,
      unreachable,
      "Deplo has no way to reach the machine it is on",
    );
    if (movable.length === 0)
      throw new Error(
        `Deplo cannot reach the machine ${unreachable[0].sourceName}'s data is on, so no data was copied and nothing was stopped on ${panelNameFor(row)}.`,
      );
  }

  await getDb()
    .update(runsTable)
    .set({ totalSteps: movable.length, doneSteps: 0 })
    .where(eq(runsTable.id, row.id));

  let failedHere = unreachable.length;
  // A machine that stopped answering mid-run takes only ITS OWN services down with
  // it: the rest of the fleet is still there and still has data to move.
  const deadMachines = new Set<string>();
  for (const [i, d] of movable.entries()) {
    if (deadMachines.has(d.sourceServerId)) {
      await markUncopied(
        row,
        [d],
        "the machine it is on stopped answering earlier in this run",
      );
      failedHere++;
      continue;
    }
    if (await stopped(row.id)) {
      // Stopped by hand: the undo has already taken everything back out, so
      // there is nothing left to mark.
      return;
    }
    await beat(row.id);
    await setProgress(row.id, { doneSteps: i, stepLabel: d.sourceName });
    // The bytes, while they cross. One service is ONE step here, so without this
    // a 15 GB volume is an hour of a progress line that never changes - which is
    // indistinguishable from a run that died, and got read as one.
    let copied = 0;
    let shownAt = 0;
    let res: Awaited<ReturnType<typeof moveMigrationServiceData>>;
    try {
      res = await moveMigrationServiceData({
        url: c.url,
        apiKey: c.apiKey,
        kind: c.kind,
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
      // The copy was cut by a Stop, not by a fault - or by the lease going to
      // another control plane, and then this one writes nothing more at all.
      if (isCopyAborted(e)) {
        if (lostLeases.has(row.id)) throw new LeaseLost(row.id);
        await stopped(row.id);
        return;
      }
      // One service that would not cut over is a line in the report, not the end
      // of the migration: everything after it used to be left with an empty
      // volume, a `running` status and nothing anywhere saying so.
      const why = e instanceof Error ? e.message : String(e);
      await markUncopied(row, [d], why);
      failedHere++;
      continue;
    }
    // A failed VOLUME is a line in the report. A failed MACHINE takes the services
    // that share it, and nothing else: the rest of the run carries on.
    if (res.sourceGone) {
      failedHere++;
      deadMachines.add(d.sourceServerId);
    }
  }

  await setProgress(row.id, { doneSteps: movable.length, stepLabel: null });
  if (failedHere > 0)
    await appendRunItem(row.id, panelNameFor(row), {
      path: "Migration",
      sourceKind: "run",
      sourceName: "Migration",
      outcome: "manual",
      message: `${failedHere} service(s) could not have their data cut over. Each is named above and refuses to deploy until you bring its data across yourself or choose "Deploy anyway" on its page.`,
    });
  // The people, while the token is still here to read them with: the run records
  // who was on that team and hands out the links, so the wizard's People step is
  // the same screen an hour later in another tab.
  try {
    await importRunMembers(row.id, await connectCredential(c));
  } catch (e) {
    console.error("[migration] bringing the members over failed:", e);
    await appendRunItem(row.id, panelNameFor(row), {
      path: "Members",
      sourceKind: "member",
      sourceName: "Members",
      outcome: "failed",
      message: `The people on this team could not be brought over: ${
        e instanceof Error ? e.message : String(e)
      } Invite them from Members.`,
    });
  }
  await finishMigration(row.id);
  await getDb()
    .update(runsTable)
    .set({ apiKeyEnc: null, runnerOwner: null, phase: "done" })
    .where(eq(runsTable.id, row.id));
  publishMigrationChanged();
  // The next team of this panel starts on the very next tick; kick one rather
  // than leaving it to the timer, so a queue moves as fast as a person would.
  void runMigrationTick().catch(() => {});
}
