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
  sourceKind: string;
  sourceId: string;
  onBytes?: OnBytes;
}

export interface DataMoveResult {
  moved: number;
  failed: number;
  notes: string[];
  sourceGone: boolean;
}

const inFlightCopies = new Map<string, AbortController>();

export function abortRunCopy(runId: string): void {
  inFlightCopies.get(runId)?.abort();
}

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
  const saidHere = (text: string) => withPanel(text, panel);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const svc = (await sourceServices(c)).find(
    (s) => s.kind === input.sourceKind && s.id === input.sourceId,
  );
  if (!svc) {
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

  if (landed.targetKind === "app") {
    await requireAppCapability(landed.targetId, "restore_backups");
  } else {
    if (!(await reachesWholeTeam())) throw new Error("Not found");
    await requireCapability("restore_backups");
  }

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

  const binds = pairHostMounts(state.hostMounts, landed.hostMounts);
  const bindOwners = binds.length
    ? await hostPathOwners(landed.targetServerId, landed.targetId, teamId)
    : [];
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
  const sourceHostsNothing = Boolean(
    (await getServerById(sourceServerId))?.importOnly,
  );
  const mayCopyHostPaths =
    (binds.every((b) => b.stackRelative) && sourceHostsNothing) ||
    ((await isInstanceAdmin()) && (await canMountHostVolumes()));

  if (paired.value.length === 0 && binds.length === 0) {
    await appendRunItem(input.runId, panel, {
      path,
      sourceKind: input.sourceKind,
      sourceName: svc.name,
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

  // Asked BEFORE the stopService below, which cannot be taken back.
  if (!(await sourceAgentReachable(sourceServerId))) {
    return refuse({
      message: UNREACHABLE_SOURCE_AGENT,
      reason: `Deplo could not reach the machine ${svc.name}'s data is on, so it was never copied`,
      note: UNREACHABLE_SOURCE_AGENT,
      sourceGone: true,
    });
  }

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

  if (landed.targetKind === "database") {
    // A floated first provision may still be running initdb into the very volume about to be replaced.
    const settled = await waitForProvision(landed.targetId, teamId);
    if (!settled)
      return refuse({
        message: `${landed.targetName} is still being created, so its data was not copied. Run the copy again once it is up.`,
        reason: `${landed.targetName} was still being created when the migration reached it, so its data was never copied`,
      });
  }

  let stoppedThere = false;
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
  if (stoppedThere)
    await recordSourceStopped(input.runId, input.sourceId, input.sourceKind);

  try {
    // Untarring into a volume a container is still writing to is the same mistake in the other direction.
    await stopStackOn(landed.targetServerId, landed.targetSlug);
    await recordStoppedForCopy(landed, teamId);
  } catch {}

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

  if (
    stoppedThere &&
    state.running &&
    tally.moved === 0 &&
    tally.failed + tally.notCopied > 0
  )
    notes.push(await startAgainThere());

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
      if (tally.moved > 0) tally.lost.push(verdict.message);
    }
  }

  const marker = { kind: landed.targetKind, id: landed.targetId } as const;
  if (tally.lost.length > 0)
    await markDataCopyFailed(marker, tally.lost.join(" | "));
  else if (tally.failed === 0) await clearDataCopyError(marker);

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

  return {
    moved: tally.moved,
    failed: tally.failed + tally.notCopied,
    notes: notes.map(saidHere),
    sourceGone: tally.sourceGone,
  };
}
