import "server-only";

import { connectAgent } from "../../infra/agent-client/connect";
import { canMountHostVolumes, isInstanceAdmin } from "../../membership";
import { sourceAgentReachable } from "../agent-reach";
import { landedFor, type Landed } from "../migration-data/landed-targets";
import { hasAppCapability } from "../node-access";
import { assertExportGate } from "./export";

export interface WorkloadRef {
  kind: "app" | "database";
  id: string;
}

export class ExportRefusedError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message);
    this.name = "ExportRefusedError";
  }
}

async function workload(ref: WorkloadRef): Promise<Landed> {
  const { teamId } = await assertExportGate();
  if (ref.kind !== "app" && ref.kind !== "database")
    throw new ExportRefusedError("kind must be app or database.", 400);
  const landed = await landedFor(teamId, {
    targetKind: ref.kind,
    targetId: ref.id,
  });
  if (!landed) throw new ExportRefusedError("Not found", 404);
  if (ref.kind === "app" && !(await hasAppCapability(ref.id, "reveal_secrets")))
    throw new ExportRefusedError("Not found", 404);
  return landed;
}

export async function checkWorkloadData(
  ref: WorkloadRef,
  volumes: string[],
): Promise<{ reachable: boolean; present: string[] | null }> {
  const landed = await workload(ref);
  const own = new Set(landed.volumes.map((v) => v.name));
  const asked = volumes.filter((v) => own.has(v));
  if (!(await sourceAgentReachable(landed.targetServerId)))
    return { reachable: false, present: null };
  if (asked.length === 0) return { reachable: true, present: [] };
  try {
    const conn = await connectAgent(landed.targetServerId);
    try {
      return {
        reachable: true,
        present: [...(await conn.volumeUsage(asked)).keys()],
      };
    } finally {
      conn.close();
    }
  } catch {
    return { reachable: true, present: null };
  }
}

// Only what the named workload mounts leaves this instance; a host path outside its own files needs the host-volumes grant.
export async function openWorkloadData(
  ref: WorkloadRef,
  what: { volume?: string; hostPath?: string; allowFile?: boolean },
): Promise<{ chunks: AsyncIterable<Buffer>; close: () => void }> {
  const landed = await workload(ref);
  if (what.volume) {
    if (!landed.volumes.some((v) => v.name === what.volume))
      throw new ExportRefusedError("Not found", 404);
  } else if (what.hostPath) {
    const mount = landed.hostMounts.find((m) => m.hostPath === what.hostPath);
    if (!mount) throw new ExportRefusedError("Not found", 404);
    if (
      !mount.stackRelative &&
      !((await isInstanceAdmin()) && (await canMountHostVolumes()))
    )
      throw new ExportRefusedError(
        `${what.hostPath} is a directory on the server itself. Handing it over needs an instance admin with the host-volumes permission on this Deplo.`,
        403,
      );
  } else throw new ExportRefusedError("Name a volume or a host path.", 400);

  const conn = await connectAgent(landed.targetServerId);
  return {
    chunks: what.volume
      ? conn.exportVolume(what.volume)
      : conn.exportHostPath(what.hostPath!, what.allowFile === true),
    close: () => conn.close(),
  };
}
