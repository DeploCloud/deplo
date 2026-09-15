import type { ResourceLimits } from "../types/container";

export interface ResourceLimitsForm {
  memoryMb: string;
  memoryReservationMb: string;
  swapMb: string;
  cpuCores: string;
  cpuShares: string;
  cpuset: string;
  pidsLimit: string;
  shmSizeMb: string;
  storageGb: string;
  nofile: string;
  nproc: string;
  oomScoreAdj: string;
}

export const EMPTY_RESOURCE_FORM: ResourceLimitsForm = {
  memoryMb: "",
  memoryReservationMb: "",
  swapMb: "",
  cpuCores: "",
  cpuShares: "",
  cpuset: "",
  pidsLimit: "",
  shmSizeMb: "",
  storageGb: "",
  nofile: "",
  nproc: "",
  oomScoreAdj: "",
};

const numStr = (n: number | null | undefined): string =>
  n == null ? "" : String(n);

export function resourcesToForm(r: ResourceLimits | null): ResourceLimitsForm {
  if (!r) return { ...EMPTY_RESOURCE_FORM };
  return {
    memoryMb: numStr(r.memoryMb),
    memoryReservationMb: numStr(r.memoryReservationMb),
    swapMb: numStr(r.swapMb),
    cpuCores: r.cpuMilli == null ? "" : String(r.cpuMilli / 1000),
    cpuShares: numStr(r.cpuShares),
    cpuset: r.cpuset ?? "",
    pidsLimit: numStr(r.pidsLimit),
    shmSizeMb: numStr(r.shmSizeMb),
    storageGb: numStr(r.storageGb),
    nofile: numStr(r.nofile),
    nproc: numStr(r.nproc),
    oomScoreAdj: numStr(r.oomScoreAdj),
  };
}

function intOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function formToLimitsInput(
  f: ResourceLimitsForm,
): Record<string, number | string | null> {
  const cpu = f.cpuCores.trim();
  const cpuNum = cpu ? Number(cpu) : null;
  return {
    memoryMb: intOrNull(f.memoryMb),
    memoryReservationMb: intOrNull(f.memoryReservationMb),
    swapMb: intOrNull(f.swapMb),
    cpuMilli:
      cpuNum != null && Number.isFinite(cpuNum)
        ? Math.round(cpuNum * 1000)
        : null,
    cpuShares: intOrNull(f.cpuShares),
    cpuset: f.cpuset.trim() || null,
    pidsLimit: intOrNull(f.pidsLimit),
    shmSizeMb: intOrNull(f.shmSizeMb),
    storageGb: intOrNull(f.storageGb),
    nofile: intOrNull(f.nofile),
    nproc: intOrNull(f.nproc),
    oomScoreAdj: intOrNull(f.oomScoreAdj),
  };
}

export const serializeResourceForm = (f: ResourceLimitsForm): string =>
  JSON.stringify(formToLimitsInput(f));

export const RESOURCE_PRESETS: {
  label: string;
  memoryMb: number;
  cpuCores: number;
}[] = [
  { label: "Nano", memoryMb: 256, cpuCores: 0.25 },
  { label: "Micro", memoryMb: 512, cpuCores: 0.5 },
  { label: "Small", memoryMb: 1024, cpuCores: 1 },
  { label: "Medium", memoryMb: 2048, cpuCores: 2 },
  { label: "Large", memoryMb: 4096, cpuCores: 4 },
];

export function activeResourcePreset(
  f: ResourceLimitsForm,
): (typeof RESOURCE_PRESETS)[number] | undefined {
  return RESOURCE_PRESETS.find(
    (p) =>
      f.memoryMb === String(p.memoryMb) && f.cpuCores === String(p.cpuCores),
  );
}

export interface ResourceSize {
  memoryMb: number;
  cpuCores: number;
}

export type HostCapacity = ResourceSize;

export function sizeFitsHost(
  size: ResourceSize,
  host: HostCapacity | null,
): boolean {
  if (!host) return true;
  return (
    (host.memoryMb <= 0 || size.memoryMb <= host.memoryMb) &&
    (host.cpuCores <= 0 || size.cpuCores <= host.cpuCores)
  );
}

export function usagePeak(
  samples: readonly { memUsed: number; cpu: number }[],
): ResourceSize | null {
  let mem = 0;
  let cpu = 0;
  for (const s of samples) {
    mem = Math.max(mem, s.memUsed);
    cpu = Math.max(cpu, s.cpu);
  }
  if (mem <= 0) return null;
  return { memoryMb: mem / 1048576, cpuCores: cpu / 100 };
}

const HEADROOM = 1.5;
const roundUp = (n: number, step: number) =>
  Math.max(step, Math.ceil(n / step) * step);

export function suggestedSize(
  peak: ResourceSize,
  host: HostCapacity | null,
): (ResourceSize & { label: string }) | null {
  const preset = RESOURCE_PRESETS.find(
    (p) =>
      p.memoryMb >= peak.memoryMb * HEADROOM &&
      p.cpuCores >= peak.cpuCores * HEADROOM &&
      sizeFitsHost(p, host),
  );
  if (preset) return preset;
  const custom = {
    label: "Custom",
    memoryMb: roundUp(peak.memoryMb * 2, 256),
    cpuCores: roundUp(peak.cpuCores * 2, 0.25),
  };
  return sizeFitsHost(custom, host) ? custom : null;
}

export function fmtMemMb(mb: number): string {
  return mb >= 1024 ? `${Number((mb / 1024).toFixed(2))} GB` : `${mb} MB`;
}

export function fmtCpu(cores: number): string {
  const n = Number(cores.toFixed(2));
  return `${n} CPU${n > 1 ? "s" : ""}`;
}
