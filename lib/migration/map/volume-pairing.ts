import type { HostMount, NamedVolume } from "../model";

import type { Mapped } from "./source-platform";
import { isDataHostPath } from "./volume-discovery";

/** A source volume matched to the Deplo volume it should be copied into. */
export interface VolumePair {
  sourceVolume: string;
  targetVolume: string;
  /** The container path, when both sides agree on it. */
  mountPath: string;
  /** Set when the pairing was made on something weaker than an equal path. */
  note: string | null;
}

/**
 * Match every source bind mount to the Deplo host mount that should receive it.
 */
export interface PairedHostMount {
  sourcePath: string;
  targetPath: string;
  mountPath: string;
  /** Deplo's own stack directory receives it, so no host path anyone typed is
   *  read or written and the host-volumes grant has nothing to gate. */
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

/** Does this host volume name carry `alias` as its compose key? Both platforms
 *  prefix the project (`myapp_apidata`, `myapp-apidata`), neither renames the key. */
function volumeCarriesAlias(volumeName: string, alias: string): boolean {
  if (!alias) return false;
  if (volumeName === alias) return true;
  const tail = volumeName.slice(-(alias.length + 1));
  return tail === `_${alias}` || tail === `-${alias}`;
}

/** Docker names an anonymous volume with its own 64-hex id. Nobody chose it, so
 *  there is never a volume on the other side that corresponds to it. */
function isAnonymousVolume(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

/** Paths an image declares that a STANDALONE never writes - the one unpairable
 *  volume on a plain Mongo, and not a loss to go looking for. */
const EMPTY_BY_DESIGN: Record<string, string> = {
  "/data/configdb":
    "MongoDB only writes it as part of a sharded cluster, so a standalone leaves it empty.",
};

/**
 * Match every source volume to the Deplo volume that should receive it.
 */
export function pairVolumes(
  source: NamedVolume[],
  target: NamedVolume[],
  opts: { singleData?: boolean } = {},
): Mapped<VolumePair[]> {
  const notes: string[] = [];
  const pairs: VolumePair[] = [];
  const takenTarget = new Set<string>();
  const takenSource = new Set<string>();

  // The compose ALIAS first: the imported file is the source's own, so the key a
  // service mounts is the same word on both sides. Matching on the container path
  // alone crosses two services that both mount /data - silently, both ways.
  // Longest alias first, so `mydata` claims its own volume before `data` can.
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
    // An anonymous volume left over is not news: the image asked for it, nobody named
    // it, and nothing on this side could ever correspond to it.
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
