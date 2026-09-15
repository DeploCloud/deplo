import "server-only";

import type { ResourceLimits } from "../../types/container";

export interface ResourceLimitsRowColumns {
  resourceMemLimitMb: number | null;
  resourceMemReservationMb: number | null;
  resourceMemSwapMb: number | null;
  resourceCpuMilli: number | null;
  resourceCpuShares: number | null;
  resourceCpuset: string | null;
  resourcePidsLimit: number | null;
  resourceShmSizeMb: number | null;
  resourceStorageSizeGb: number | null;
  resourceUlimitNofile: number | null;
  resourceUlimitNproc: number | null;
  resourceOomScoreAdj: number | null;
}

export function assembleResources(
  row: ResourceLimitsRowColumns,
): ResourceLimits | null {
  const r: ResourceLimits = {
    memoryMb: row.resourceMemLimitMb,
    memoryReservationMb: row.resourceMemReservationMb,
    swapMb: row.resourceMemSwapMb,
    cpuMilli: row.resourceCpuMilli,
    cpuShares: row.resourceCpuShares,
    cpuset: row.resourceCpuset,
    pidsLimit: row.resourcePidsLimit,
    shmSizeMb: row.resourceShmSizeMb,
    storageGb: row.resourceStorageSizeGb,
    nofile: row.resourceUlimitNofile,
    nproc: row.resourceUlimitNproc,
    oomScoreAdj: row.resourceOomScoreAdj,
  };
  return Object.values(r).some((v) => v != null) ? r : null;
}

export function resourceLimitsToRow(
  r: ResourceLimits | null,
): ResourceLimitsRowColumns {
  return {
    resourceMemLimitMb: r?.memoryMb ?? null,
    resourceMemReservationMb: r?.memoryReservationMb ?? null,
    resourceMemSwapMb: r?.swapMb ?? null,
    resourceCpuMilli: r?.cpuMilli ?? null,
    resourceCpuShares: r?.cpuShares ?? null,
    resourceCpuset: r?.cpuset ?? null,
    resourcePidsLimit: r?.pidsLimit ?? null,
    resourceShmSizeMb: r?.shmSizeMb ?? null,
    resourceStorageSizeGb: r?.storageGb ?? null,
    resourceUlimitNofile: r?.nofile ?? null,
    resourceUlimitNproc: r?.nproc ?? null,
    resourceOomScoreAdj: r?.oomScoreAdj ?? null,
  } satisfies ResourceLimitsRowColumns;
}
