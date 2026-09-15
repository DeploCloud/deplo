import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { requireMountHostVolumes } from "../../membership";
import { resourceLimitsToRow } from "../app-graph-rows/resource-limits";
import { requireAppCapability } from "../node-access";
import { recordActivity } from "../activity";
import { updateAppOwned } from "./settings";
import type { ResourceLimits } from "../../types/container";

export type ResourceLimitsInput = {
  [K in keyof ResourceLimits]?: ResourceLimits[K] | null;
};

const MEM_MB_MAX = 1_048_576;
const CPU_MILLI_MAX = 512_000;
const PIDS_MAX = 4_194_304;
const CPU_SHARES_MIN = 2;
const CPU_SHARES_MAX = 262_144;

function intLimit(
  v: number | null | undefined,
  label: string,
  min: number,
  max: number,
): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`${label} must be a whole number.`);
  }
  if (v < min) throw new Error(`${label} must be at least ${min}.`);
  if (v > max) throw new Error(`${label} must be at most ${max}.`);
  return v;
}

function cleanCpuset(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (!s) return null;
  if (!/^\d+([-,]\d+)*$/.test(s)) {
    throw new Error(
      'CPU pinning must be a core list like "0", "0,2" or "0-3".',
    );
  }
  return s;
}

export function cleanResourceLimits(
  input: ResourceLimitsInput,
): ResourceLimits {
  const memoryMb = intLimit(input.memoryMb, "Memory limit", 6, MEM_MB_MAX);
  const memoryReservationMb = intLimit(
    input.memoryReservationMb,
    "Memory reservation",
    6,
    MEM_MB_MAX,
  );
  const swapMb = intLimit(input.swapMb, "Swap limit", 6, MEM_MB_MAX * 2);
  const cpuMilli = intLimit(input.cpuMilli, "CPU limit", 10, CPU_MILLI_MAX);
  const cpuShares = intLimit(
    input.cpuShares,
    "CPU shares",
    CPU_SHARES_MIN,
    CPU_SHARES_MAX,
  );
  const cpuset = cleanCpuset(input.cpuset);
  const pidsLimit = intLimit(input.pidsLimit, "Process limit", 1, PIDS_MAX);
  const shmSizeMb = intLimit(input.shmSizeMb, "Shared memory", 1, MEM_MB_MAX);
  const storageGb = intLimit(input.storageGb, "Disk limit", 1, 65_536);
  const nofile = intLimit(input.nofile, "Open-files limit", 1, 1_073_741_816);
  const nproc = intLimit(input.nproc, "Process (ulimit) limit", 1, PIDS_MAX);
  const oomScoreAdj = intLimit(
    input.oomScoreAdj,
    "OOM score adjust",
    -1000,
    1000,
  );

  if (
    memoryReservationMb != null &&
    memoryMb != null &&
    memoryReservationMb > memoryMb
  ) {
    throw new Error("Memory reservation can't exceed the memory limit.");
  }
  if (swapMb != null) {
    if (memoryMb == null) {
      throw new Error(
        "Set a memory limit before a swap limit - the swap value is the memory + swap total.",
      );
    }
    if (swapMb < memoryMb) {
      throw new Error(
        "Swap limit must be at least the memory limit (it's the combined memory + swap total).",
      );
    }
  }

  return {
    memoryMb,
    memoryReservationMb,
    swapMb,
    cpuMilli,
    cpuShares,
    cpuset,
    pidsLimit,
    shmSizeMb,
    storageGb,
    nofile,
    nproc,
    oomScoreAdj,
  };
}

export async function updateAppResources(
  id: string,
  input: ResourceLimitsInput,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const cleaned = cleanResourceLimits(input);

  // A negative oom_score_adj spares THIS container and kills its neighbours, so it takes the host grant.
  if (cleaned.oomScoreAdj != null && cleaned.oomScoreAdj < 0) {
    await requireMountHostVolumes();
  }
  await updateAppOwned(id, membership.teamId, {
    ...resourceLimitsToRow(cleaned),
    pendingChangesAt: nowIso(),
    updatedAt: nowIso(),
  });
  await recordActivity("app", "Updated resource limits", user.name, id);
}
