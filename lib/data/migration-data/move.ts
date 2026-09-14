import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { migrationRunTargets as targetsTable } from "../../db/schema/control-plane/migration";
import { nowIso } from "../../ids";
import { getCurrentUser } from "../../auth/current-user";
import {
  canMountHostVolumes,
  isInstanceAdmin,
  reachesWholeTeam,
  requireCapability,
} from "../../membership";
import { connectAgent } from "../../infra/agent-client/connect";
import { publishDatabaseChanged } from "../../graphql/pubsub";

import { sourceClient, StopAcceptedError } from "../../migration/source";
import { withPanel } from "../../migration/map/source-platform";
import {
  isDataHostPath,
  normalizePath,
} from "../../migration/map/volume-discovery";
import {
  pairHostMounts,
  pairVolumes,
} from "../../migration/map/volume-pairing";

import { sourceAgentReachable } from "../agent-reach";
import { requireAppCapability } from "../node-access";
import { stopStackOn, type OnBytes } from "../volume-migration";
import { recordActivity } from "../activity";
import { clearDataCopyError, markDataCopyFailed } from "../data-copy";
import { runAsMigration } from "../migration-guard";
import { getServerById } from "../servers/roster";
import {
  assertImportGate,
  credentialFor,
  type ConnectInput,
} from "../migration-import/gates";
import {
  appendRunItem,
  ownRun,
  refreshCounts,
} from "../migration-import/run-report";

import { UNREACHABLE_SOURCE_AGENT, unfilledStackBinds } from "./copy-notes";
import {
  copyBindMounts,
  copyPairedVolumes,
  newCopyTally,
  type CopyContext,
} from "./copy-pass";
import { startAndVerifyDatabase, waitForProvision } from "./database-verify";
import { hostPathOwners } from "./host-path-clashes";
import { landedFor, runTargets, type Landed } from "./landed-targets";
import {
  recordSourceStopped,
  resolveSourceServer,
  volumesOnHost,
} from "./source-cutover";
import { sourceServices, type SourceService } from "./source-services";

export interface MoveInput extends ConnectInput {
  runId: string;
  /** The source service to cut over. Its volumes are DERIVED, never passed in. */
  sourceKind: string;
  sourceId: string;
  /** Bytes as they cross, for a caller that shows progress while this runs. */
  onBytes?: OnBytes;
}

export interface DataMoveResult {
  moved: number;
  failed: number;
  notes: string[];
  /** The source machine stopped answering PART WAY THROUGH - a gRPC UNAVAILABLE,
   *  which is a connection that died, not a volume that could not be read. */
  sourceGone: boolean;
}

/** The copy each run currently has in flight, so a Stop can reach into it. */
const inFlightCopies = new Map<string, AbortController>();

/** Cut the copy this run has open, if it has one. Safe to call when it has not. */
export function abortRunCopy(runId: string): void {
  inFlightCopies.get(runId)?.abort();
}

/** Write down the stop the copy just performed, because it was DELIBERATE. */
async function recordStoppedForCopy(
  landed: Landed,
  teamId: string,
): Promise<void> {
  if (landed.targetKind === "database") {
    await getDb()
      .update(databasesTable)
      .set({ status: "stopped" })
      .where(
        and(
          eq(databasesTable.id, landed.targetId),
          eq(databasesTable.teamId, teamId),
        ),
      );
    // The status badge holds an open subscription; without this it keeps the
    // snapshot it opened with until the page is reloaded.
    publishDatabaseChanged(landed.targetId);
    return;
  }
  await getDb()
    .update(appsTable)
    .set({ status: "idle", updatedAt: nowIso() })
    .where(
      and(eq(appsTable.id, landed.targetId), eq(appsTable.teamId, teamId)),
    );
}

/**
 * The one shape every pre-copy refusal takes: say it in the run report, mark the
 * target so a deploy refuses to start on data that never arrived, and answer the
 * caller. Nothing has been stopped or written when one of these fires.
 */
function refusalFor(base: {
  runId: string;
  teamId: string;
  panel: string;
  path: string;
  sourceKind: string;
  svc: SourceService;
  landed: Landed;
  notes: string[];
  saidHere: (text: string) => string;
}) {
  return async (r: {
    message: string;
    reason: string;
    note?: string;
    sourceGone?: boolean;
  }): Promise<DataMoveResult> => {
    await appendRunItem(base.runId, base.panel, {
      path: base.path,
      sourceKind: base.sourceKind,
      sourceName: base.svc.name,
      sourceId: base.svc.id,
      outcome: "failed",
      targetKind: base.landed.targetKind,
      targetId: base.landed.targetId,
      message: r.message,
    });
    await markDataCopyFailed(
      { kind: base.landed.targetKind, id: base.landed.targetId },
      r.reason,
      { unlessCopiedIn: base.runId },
    );
    await refreshCounts(base.runId, base.teamId);
    return {
      moved: 0,
      failed: 1,
      notes: (r.note ? [...base.notes, r.note] : base.notes).map(base.saidHere),
      sourceGone: r.sourceGone ?? false,
    };
  };
}

/**
 * Cut one service's data over: stop it on the source panel, then copy every
 * paired volume into the app or database that was imported from it.
 */
export async function moveMigrationServiceData(
  input: MoveInput,
): Promise<DataMoveResult> {
  return runAsMigration(() => runMoveMigrationServiceData(input));
}

async function runMoveMigrationServiceData(
  input: MoveInput,
): Promise<DataMoveResult> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);
  const panel = sourceClient(c).displayName;
  // The run log resolves `{panel}` in `Report.add`; what this RETURNS goes to a
  // screen instead (the recopy dialog), so it has to be resolved here too.
  const saidHere = (text: string) => withPanel(text, panel);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const svc = (await sourceServices(c)).find(
    (s) => s.kind === input.sourceKind && s.id === input.sourceId,
  );
  if (!svc) {
    // The listing drops a service whose detail call failed, which is not the same
    // fact as "it is gone" - a panel restarting answers that way for a moment.
    const stumbled = await sourceClient(c)
      .getService(input.sourceKind, input.sourceId)
      .catch(() => null);
    throw new Error(
      stumbled
        ? `${panel} did not answer for ${stumbled.appName?.trim() || input.sourceId} this time. Nothing was copied and nothing here was changed - run the copy again.`
        : `That service is no longer on the ${panel} instance.`,
    );
  }

  const target = (await runTargets(input.runId)).get(svc.id);
  const landed = target ? await landedFor(teamId, target) : null;
  const path = `${svc.projectName} / ${svc.environmentName} / ${svc.name}`;
  if (!landed)
    throw new Error(
      `This import did not create anything for ${svc.name}, so there is nothing here to copy its data into. Import its configuration first.`,
    );

  // The target's own gate. A database has no node dimension, so it stays team-wide
  // and answers NOT FOUND to a narrowed principal rather than confirming the id
  // exists - the rule `requireBackupCapability` states for the same reason.
  if (landed.targetKind === "app") {
    await requireAppCapability(landed.targetId, "restore_backups");
  } else {
    if (!(await reachesWholeTeam())) throw new Error("Not found");
    await requireCapability("restore_backups");
  }

  // Which Deplo server holds the source volumes.
  const sourceServerId = await resolveSourceServer(c, teamId, svc.serverId);

  const state = await sourceClient(c).serviceRuntime(svc);
  const paired = pairVolumes(state.volumes, landed.volumes, {
    singleData: landed.targetKind === "database",
  });
  const notes = [...state.notes, ...paired.notes];
  const refuse = refusalFor({
    runId: input.runId,
    teamId,
    panel,
    path,
    sourceKind: input.sourceKind,
    svc,
    landed,
    notes,
    saidHere,
  });

  // A bind mount's bytes sit in a plain host directory, so copying one reads and
  // writes an arbitrary path on two machines.
  const binds = pairHostMounts(state.hostMounts, landed.hostMounts);
  const bindOwners = binds.length
    ? await hostPathOwners(landed.targetServerId, landed.targetId, teamId)
    : [];
  // One nothing here mounts. Silent, this read as a stack that came across whole,
  // with an empty directory inside it.
  for (const m of state.hostMounts)
    if (
      isDataHostPath(m.hostPath) &&
      !binds.some((b) => b.sourcePath === m.hostPath) &&
      !landed.fileMounts.has(normalizePath(m.mountPath))
    )
      notes.push(
        `${m.hostPath} is mounted at ${m.mountPath} on {panel}, but nothing of ${landed.targetName} mounts that path here - what is in it was not copied.`,
      );
  notes.push(...unfilledStackBinds(landed, binds));
  // A `./x` bind is Deplo's own stack directory on both sides, so there is no host
  // path anybody typed to gate - and only off a machine that hosts nothing else
  // (a migration source, ADR-0025), since a fleet host's paths are other tenants'.
  const sourceHostsNothing = Boolean(
    (await getServerById(sourceServerId))?.importOnly,
  );
  const mayCopyHostPaths =
    (binds.every((b) => b.stackRelative) && sourceHostsNothing) ||
    ((await isInstanceAdmin()) && (await canMountHostVolumes()));

  if (paired.value.length === 0 && binds.length === 0) {
    // Nothing to copy means nothing is stopped either: a cutover that would move
    // no bytes has no business taking the source down.
    await appendRunItem(input.runId, panel, {
      path,
      sourceKind: input.sourceKind,
      sourceName: svc.name,
      // "Deplo could not find out" is a decision for a person, not a clean skip -
      // see ServiceRuntime.undetermined.
      outcome: state.undetermined ? "manual" : "skipped",
      targetKind: landed.targetKind,
      targetId: landed.targetId,
      message:
        notes.join(" ") ||
        "Nothing to move: this service has no data of its own on {panel}.",
    });
    await refreshCounts(input.runId, teamId);
    return {
      moved: 0,
      failed: 0,
      notes: notes.map(saidHere),
      sourceGone: false,
    };
  }

  // Everything below this point either stops something or writes something, and
  // `stopService` a few lines down is the point of no return. The machine that
  // holds the bytes has to answer FIRST - see `sourceAgentReachable`.
  if (!(await sourceAgentReachable(sourceServerId))) {
    // Nothing was stopped and nothing was copied, and every other service on
    // this machine is about to hit the same wall - so it counts as gone.
    return refuse({
      message: UNREACHABLE_SOURCE_AGENT,
      reason: `Deplo could not reach the machine ${svc.name}'s data is on, so it was never copied`,
      note: UNREACHABLE_SOURCE_AGENT,
      sourceGone: true,
    });
  }

  // ...and it has to HOLD the bytes. Deplo knows the exact volume names here, so
  // asking costs one RPC and answers the question the stop below cannot be taken
  // back from: a service stopped on the source panel whose volumes live on a
  // different machine is the old platform down AND an empty app here.
  if (state.running && (binds.length === 0 || !mayCopyHostPaths)) {
    const wanted = paired.value.map((p) => p.sourceVolume);
    const present = await volumesOnHost(sourceServerId, wanted);
    if (present && wanted.length > 0 && !wanted.some((n) => present.has(n))) {
      const message = `${svc.name} is running on {panel}, but none of the volumes it names (${wanted.join(", ")}) are on the machine {panel} says it runs on - so its data is somewhere else. Nothing was stopped and nothing was copied. Correct that machine's address under the Connect step and run the copy again.`;
      return refuse({
        message,
        reason: `None of ${svc.name}'s volumes are on the machine ${panel} says it runs on, so its data was never copied`,
        note: message,
      });
    }
  }

  // A database is provisioned in the BACKGROUND by the import (`createDatabase`
  // floats it), so at this point its first container may still be running `initdb`
  // into the very volume about to be replaced.
  if (landed.targetKind === "database") {
    const settled = await waitForProvision(landed.targetId, teamId);
    if (!settled)
      return refuse({
        message: `${landed.targetName} is still being created, so its data was not copied. Run the copy again once it is up.`,
        reason: `${landed.targetName} was still being created when the migration reached it, so its data was never copied`,
      });
  }

  // The point of no return, and what makes the copy trustworthy - EXCEPT for a
  // service the panel will not stop because it was never deployed, which answers
  // 500 to its own stop. Nothing is running, so nothing is moving under the
  // copy; the run has no business ending over it.
  let stoppedThere = false;
  // The way back up over there, for a service Deplo stopped and then copied
  // nothing from: "stopped on the old panel, empty on the new one" is the outcome
  // this whole step exists to prevent.
  const startAgainThere = async (): Promise<string> => {
    try {
      await sourceClient(c).startService(input.sourceKind, input.sourceId);
      await getDb()
        .update(targetsTable)
        .set({ stoppedAt: null, stoppedKind: null })
        .where(
          and(
            eq(targetsTable.runId, input.runId),
            eq(targetsTable.serviceId, input.sourceId),
          ),
        );
      return `${svc.name} was started again on {panel}, since none of its data came across.`;
    } catch (e) {
      return `${svc.name} is still stopped on {panel} (${e instanceof Error ? e.message : "it would not start"}). Start it there yourself until the copy succeeds.`;
    }
  };
  try {
    await sourceClient(c).stopService(input.sourceKind, input.sourceId);
    stoppedThere = true;
  } catch (e) {
    const why = e instanceof Error ? e.message : `${panel} refused`;
    if (state.running) {
      // The panel TOOK the stop and only its status lagged: Deplo did stop it, so
      // it is written down (a cancel starts it again) and started again now.
      let undone = "";
      if (e instanceof StopAcceptedError) {
        await recordSourceStopped(
          input.runId,
          input.sourceId,
          input.sourceKind,
        );
        undone = ` ${await startAgainThere()}`;
      }
      return refuse({
        message: `${svc.name} is still running on {panel} and would not stop (${why}), so its data was not copied - copying a volume being written to would arrive corrupted.${undone} Run the copy again.`,
        reason: `${svc.name} would not stop on ${panel}, so its data was never copied`,
      });
    }
    notes.push(
      `{panel} would not stop ${svc.name} (${why}), but nothing of it is running there, so its data was read as it is.`,
    );
  }
  // Only a stop that HAPPENED is written down: backing out of a takeover starts
  // these again, and starting something the operator had stopped themselves
  // would be this feature undoing their decision.
  if (stoppedThere)
    await recordSourceStopped(input.runId, input.sourceId, input.sourceKind);

  // Stop the destination too: untarring into a volume a container is writing to is
  // the same mistake in the other direction.
  try {
    await stopStackOn(landed.targetServerId, landed.targetSlug);
    await recordStoppedForCopy(landed, teamId);
  } catch {
    /* nothing of ours is running there yet */
  }

  const tally = newCopyTally();
  const source = await connectAgent(sourceServerId);
  const dest =
    sourceServerId === landed.targetServerId
      ? source
      : await connectAgent(landed.targetServerId);
  const aborter = new AbortController();
  inFlightCopies.set(input.runId, aborter);
  const ctx: CopyContext = {
    credential: c,
    runId: input.runId,
    panel,
    path,
    svc,
    landed,
    running: state.running,
    sourceServerId,
    source,
    dest,
    signal: aborter.signal,
    onBytes: input.onBytes,
    notes,
    tally,
  };
  try {
    await copyPairedVolumes(ctx, paired.value);
    await copyBindMounts(ctx, binds, bindOwners, mayCopyHostPaths);
  } finally {
    inFlightCopies.delete(input.runId);
    source.close();
    if (dest !== source) dest.close();
  }

  // A database is brought back up and CHECKED - the claim anyone cares about is
  // "the engine reads them", not "the bytes are in the volume". Brought up on both
  // sides even when NOTHING was copied: the copy stopped it, and an empty service
  // is no reason to leave somebody's database down.
  if (
    stoppedThere &&
    state.running &&
    tally.moved === 0 &&
    tally.failed + tally.notCopied > 0
  )
    notes.push(await startAgainThere());

  // ...but never on a volume that is known to hold NOTHING of the source's: a
  // running source whose data is elsewhere would come up as a fresh engine that
  // apps then write into, and the recopy later wipes those writes.
  if (
    landed.targetKind === "database" &&
    tally.failed === 0 &&
    tally.notCopied === 0
  ) {
    const verdict = await startAndVerifyDatabase(
      landed,
      teamId,
      tally.moved > 0,
    );
    await appendRunItem(input.runId, panel, {
      path,
      sourceKind: input.sourceKind,
      sourceName: svc.name,
      sourceId: svc.id,
      outcome: verdict.ok ? "created" : "failed",
      targetKind: "database",
      targetId: landed.targetId,
      message: verdict.message,
    });
    if (!verdict.ok) {
      tally.failed++;
      // Only a copy that MOVED bytes can have lost any. A database that will not
      // come back up on the volume Deplo just made is a start problem, and saying
      // "its data did not come across" would send people looking for data.
      if (tally.moved > 0) tally.lost.push(verdict.message);
    }
  }

  // The verdict on the whole service, written where a deploy will read it.
  const marker = { kind: landed.targetKind, id: landed.targetId } as const;
  if (tally.lost.length > 0)
    await markDataCopyFailed(marker, tally.lost.join(" | "));
  else if (tally.failed === 0) await clearDataCopyError(marker);

  // The app half is left stopped on purpose, and the report has to say which verb
  // starts it again - a user staring at a stopped app wondering whether the move
  // broke it is a failure of the report, not of the move.
  if (tally.moved > 0 && landed.targetKind === "app")
    notes.push(
      `${landed.targetName} is stopped on both sides. Press Deploy when the traffic should follow the data.`,
    );
  if (tally.empty > 0 && tally.moved === 0)
    notes.push(
      tally.missing === tally.empty && !state.running
        ? `Nothing was copied for ${landed.targetName}: it was never started on {panel}, so it has no data there yet. Press Deploy and it starts fresh.`
        : tally.missing === tally.empty
          ? `Nothing was copied for ${landed.targetName}: none of the volumes {panel} names are on the machine it says ${svc.name} runs on.`
          : `Nothing was copied for ${landed.targetName}: every volume it has on {panel} is empty.`,
    );

  for (const message of notes)
    await appendRunItem(input.runId, panel, {
      path,
      sourceKind: input.sourceKind,
      sourceName: svc.name,
      outcome: "manual",
      targetKind: landed.targetKind,
      targetId: landed.targetId,
      message,
    });

  await refreshCounts(input.runId, teamId);
  await recordActivity(
    landed.targetKind === "app" ? "app" : "database",
    `Moved ${tally.moved} data volume(s) from ${panel} into ${landed.targetName}`,
    (await getCurrentUser())?.name ?? "someone",
    landed.targetKind === "app" ? landed.targetId : null,
    teamId,
    null,
    landed.targetKind === "database" ? landed.targetId : null,
  );

  // What the caller and the summary read: data that should have arrived and did
  // not counts, whether the copy threw or the volume was simply not there.
  return {
    moved: tally.moved,
    failed: tally.failed + tally.notCopied,
    notes: notes.map(saidHere),
    sourceGone: tally.sourceGone,
  };
}
