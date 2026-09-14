import "server-only";

import { sourceClient } from "../../migration/source";
import { withPanel } from "../../migration/map/source-platform";
import {
  pairHostMounts,
  pairVolumes,
} from "../../migration/map/volume-pairing";
import type { PairedHostMount } from "../../migration/map/volume-pairing";

import { sourceAgentReachable } from "../agent-reach";
import {
  assertImportGate,
  credentialFor,
  type ConnectInput,
} from "../migration-import/gates";
import { ownRun } from "../migration-import/run-report";
import { migrationMachines } from "../migration-import/source-machines";

import {
  UNREACHABLE_SOURCE_AGENT,
  UNREACHABLE_SOURCE_HOST,
  sharedPathNote,
  unfilledStackBinds,
} from "./copy-notes";
import { hostPathOwners, pathsOverlap, runTwinFor } from "./host-path-clashes";
import { landedFor, runTargets } from "./landed-targets";
import { sourceServices } from "./source-services";

export interface DataMoveVolume {
  sourceVolume: string;
  targetVolume: string;
  mountPath: string;
  note: string | null;
}

export interface DataMoveService {
  /** `Project / Environment / service`, as it reads on the source panel. */
  path: string;
  /** `application` | `compose` | one of the five engines. */
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  projectName: string;
  environmentName: string;
  /** The source machine that runs it; empty string is the panel's own host. */
  sourceServerId: string;
  targetKind: "app" | "database";
  targetId: string;
  targetName: string;
  /** The Deplo server that holds the data once it is here. */
  targetServerId: string;
  /** Whether the source is still up over there. */
  running: boolean;
  /** Whether the machine holding this service's data ANSWERS us - a live Hello,
   *  not the stored status, which goes green on the call-home. */
  sourceReachable: boolean;
  volumes: DataMoveVolume[];
  notes: string[];
}

/**
 * Every service THIS RUN imported whose data can still be moved. Scoped to the
 * run: the copy wipes its target before writing, so the pairing has to be a fact
 * the run recorded, never a name that happens to match.
 *
 * ponytail: one container list + one inspect per container, per service. A fleet
 * with hundreds wants the container list cached per HOST.
 */
export async function planMigrationDataMove(
  input: ConnectInput & { runId: string },
): Promise<DataMoveService[]> {
  const { teamId } = await assertImportGate();
  const c = await credentialFor(input);
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");

  const targets = await runTargets(input.runId);
  if (targets.size === 0) return [];

  // The mappers write `{panel}`; only `Report.add` used to resolve it, so every
  // note that reached a SCREEN instead of the run log still said "{panel} says".
  const panel = sourceClient(c).displayName;
  const said = (text: string) => withPanel(text, panel);
  const machines = await migrationMachines(c, teamId);
  const out: DataMoveService[] = [];
  // One Hello per distinct machine, not per service: several services share a host
  // and the answer cannot differ between them.
  const answered = new Map<string, Promise<boolean>>();
  const agentAnswers = (serverId: string) => {
    let p = answered.get(serverId);
    if (!p) {
      p = sourceAgentReachable(serverId);
      answered.set(serverId, p);
    }
    return p;
  };

  // One pass per MACHINE, not per service: the plan lists tens of services and
  // reading who owns a host path parses every app's compose on that host.
  const ownedBy = new Map<
    string,
    Promise<{ appId: string; name: string; path: string }[]>
  >();
  const ownersOn = (serverId: string | null) => {
    if (!serverId) return Promise.resolve([]);
    let p = ownedBy.get(serverId);
    if (!p) {
      p = hostPathOwners(serverId, "", teamId);
      ownedBy.set(serverId, p);
    }
    return p;
  };

  for (const svc of await sourceServices(c)) {
    const target = targets.get(svc.id);
    if (!target) continue;
    const landed = await landedFor(teamId, target);
    if (!landed) continue;

    const state = await sourceClient(c).serviceRuntime(svc);
    const paired = pairVolumes(state.volumes, landed.volumes, {
      singleData: landed.targetKind === "database",
    });
    const binds = pairHostMounts(state.hostMounts, landed.hostMounts);
    const sourceServer = machines.find(
      (m) => m.sourceId === svc.serverId,
    )?.deploServerId;
    // Same machine, same path: nothing is copied, so nothing can be wiped either.
    const inPlace = (b: PairedHostMount) =>
      sourceServer === landed.targetServerId && b.sourcePath === b.targetPath;
    const owners = binds.length ? await ownersOn(landed.targetServerId) : [];
    const shared: string[] = [];
    for (const b of binds) {
      if (inPlace(b)) continue;
      const clash = owners.find(
        (o) =>
          o.appId !== landed.targetId && pathsOverlap(o.path, b.targetPath),
      );
      if (!clash) continue;
      shared.push(
        (await runTwinFor(c, input.runId, svc, clash.appId))
          ? `${b.targetPath} is shared with ${clash.name}, which mounts the same directory on {panel} - it is copied once, for both.`
          : sharedPathNote(clash, b.targetPath),
      );
    }
    // Said HERE, before anything is stopped: a machine Deplo cannot read is a machine
    // whose data cannot move at all, and the review screen is where that has to be read
    // - not the cutover, with the old platform already down.
    const reachable = sourceServer ? await agentAnswers(sourceServer) : false;

    out.push({
      path: `${svc.projectName} / ${svc.environmentName} / ${svc.name}`,
      sourceKind: svc.kind,
      sourceId: svc.id,
      sourceName: svc.name,
      projectName: svc.projectName,
      environmentName: svc.environmentName,
      sourceServerId: svc.serverId,
      targetKind: landed.targetKind,
      targetId: landed.targetId,
      targetName: landed.targetName,
      targetServerId: landed.targetServerId,
      running: state.running,
      sourceReachable: reachable,
      volumes: [
        ...paired.value,
        // A bind mount is listed as what it is: a host PATH - a directory or a single
        // file - copied by a different RPC behind a different permission. Which of the
        // two it is only the host knows, so the copy says it and the plan does not guess.
        ...binds.map((b) => ({
          sourceVolume: b.sourcePath,
          targetVolume: b.targetPath,
          mountPath: b.mountPath,
          note: inPlace(b)
            ? "Already on this machine at the same path - nothing to copy."
            : b.stackRelative
              ? "A path the stack binds beside its own compose file, not a volume."
              : "A path on the host, not a volume. Copying it needs instance admin and the host-volumes permission.",
        })),
      ].map((v) => ({ ...v, note: v.note ? said(v.note) : null })),
      notes: [
        ...state.notes,
        ...paired.notes,
        ...unfilledStackBinds(landed, binds),
        ...shared,
        ...(reachable
          ? []
          : [
              sourceServer ? UNREACHABLE_SOURCE_AGENT : UNREACHABLE_SOURCE_HOST,
            ]),
      ].map(said),
    });
  }
  return out;
}
