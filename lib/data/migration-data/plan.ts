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
  path: string;
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  projectName: string;
  environmentName: string;
  sourceServerId: string;
  targetKind: "app" | "database";
  targetId: string;
  targetName: string;
  targetServerId: string;
  running: boolean;
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

  const panel = sourceClient(c).displayName;
  const said = (text: string) => withPanel(text, panel);
  const machines = await migrationMachines(c, teamId);
  const out: DataMoveService[] = [];
  const answered = new Map<string, Promise<boolean>>();
  const agentAnswers = (serverId: string) => {
    let p = answered.get(serverId);
    if (!p) {
      p = sourceAgentReachable(serverId);
      answered.set(serverId, p);
    }
    return p;
  };

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
