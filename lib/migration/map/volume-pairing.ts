import type { HostMount, NamedVolume } from "../model";

import type { Mapped } from "./source-platform";
import { isDataHostPath } from "./volume-discovery";

export interface VolumePair {
  sourceVolume: string;
  targetVolume: string;
  mountPath: string;
  note: string | null;
}

export interface PairedHostMount {
  sourcePath: string;
  targetPath: string;
  mountPath: string;
  stackRelative: boolean;
}

export function pairHostMounts(
  source: HostMount[],
  target: HostMount[],
): PairedHostMount[] {
  const out: PairedHostMount[] = [];
  for (const s of source) {
    if (!isDataHostPath(s.hostPath)) continue;
    const hit = target.find((t) => t.mountPath === s.mountPath);
    if (!hit) continue;
    out.push({
      sourcePath: s.hostPath,
      targetPath: hit.hostPath,
      mountPath: s.mountPath,
      stackRelative: hit.stackRelative === true,
    });
  }
  return out;
}

function volumeCarriesAlias(volumeName: string, alias: string): boolean {
  if (!alias) return false;
  if (volumeName === alias) return true;
  const tail = volumeName.slice(-(alias.length + 1));
  return tail === `_${alias}` || tail === `-${alias}`;
}

function isAnonymousVolume(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

const EMPTY_BY_DESIGN: Record<string, string> = {
  "/data/configdb":
    "MongoDB only writes it as part of a sharded cluster, so a standalone leaves it empty.",
};

export function pairVolumes(
  source: NamedVolume[],
  target: NamedVolume[],
  opts: { singleData?: boolean } = {},
): Mapped<VolumePair[]> {
  const notes: string[] = [];
  const pairs: VolumePair[] = [];
  const takenTarget = new Set<string>();
  const takenSource = new Set<string>();

  for (const t of [...target].sort(
    (a, b) => (b.alias?.length ?? 0) - (a.alias?.length ?? 0),
  )) {
    if (!t.alias) continue;
    const hit = source.find(
      (s) => !takenSource.has(s.name) && volumeCarriesAlias(s.name, t.alias!),
    );
    if (!hit) continue;
    takenSource.add(hit.name);
    takenTarget.add(t.name);
    pairs.push({
      sourceVolume: hit.name,
      targetVolume: t.name,
      mountPath: hit.mountPath,
      note: null,
    });
  }

  for (const s of source) {
    if (takenSource.has(s.name)) continue;
    const hit = target.find(
      (t) => !takenTarget.has(t.name) && t.mountPath === s.mountPath,
    );
    if (hit) {
      takenTarget.add(hit.name);
      takenSource.add(s.name);
      pairs.push({
        sourceVolume: s.name,
        targetVolume: hit.name,
        mountPath: s.mountPath,
        note: null,
      });
    }
  }

  if (
    pairs.length === 0 &&
    opts.singleData &&
    source.length === 1 &&
    target.length === 1
  ) {
    pairs.push({
      sourceVolume: source[0].name,
      targetVolume: target[0].name,
      mountPath: target[0].mountPath,
      note:
        `The data directory moved: {panel} mounted it at ${source[0].mountPath}, Deplo mounts ${target[0].mountPath}. ` +
        "The copy is still the right one - one data volume on each side, and Deplo pins the engine's data path to where it mounts it.",
    });
  }

  for (const s of source)
    if (
      !pairs.some((p) => p.sourceVolume === s.name) &&
      !isAnonymousVolume(s.name)
    )
      notes.push(
        `${s.name} is mounted at ${s.mountPath} on {panel}, but no volume of this app mounts that path.` +
          (EMPTY_BY_DESIGN[s.mountPath]
            ? ` ${EMPTY_BY_DESIGN[s.mountPath]}`
            : ""),
      );
  for (const t of target)
    if (!pairs.some((p) => p.targetVolume === t.name))
      notes.push(
        `${t.name} (${t.mountPath}) stays empty - nothing on {panel} is mounted there.`,
      );

  return { value: pairs, notes };
}
