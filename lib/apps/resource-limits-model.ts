import type { ResourceLimits } from "../types";

/**
 * The pure data model behind the Resources settings form - the string ⇄ number
 * mapping, dirty-key serialization, and quick-pick presets, with NO React so it
 * unit-tests directly (the same split as `volumesKey` / `breadcrumb-model`).
 */
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

/** Current saved limits → the editable form (null ⇒ everything blank). */
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

/** Parse a whole-number field: ""→null, else rounded (the server range-checks). */
function intOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Form → the `ResourceLimitsInput` GraphQL variables (the whole set; ""→null
 * clears that dimension). Cores are converted to milli-CPUs here.
 */
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

/** A stable key for dirty-tracking (form matches its saved snapshot iff equal). */
export const serializeResourceForm = (f: ResourceLimitsForm): string =>
  JSON.stringify(formToLimitsInput(f));

/** Quick-pick sizes filling Memory + CPU (the common two). */
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

/** The preset whose Memory+CPU exactly matches the current form, if any. */
export function activeResourcePreset(
  f: ResourceLimitsForm,
): (typeof RESOURCE_PRESETS)[number] | undefined {
  return RESOURCE_PRESETS.find(
    (p) =>
      f.memoryMb === String(p.memoryMb) && f.cpuCores === String(p.cpuCores),
  );
}

/** A Memory + CPU pair in the form's units. */
export interface ResourceSize {
  memoryMb: number;
  cpuCores: number;
}

/** The owning machine's capacity; 0 on either axis means "not reported yet". */
export type HostCapacity = ResourceSize;

/** False only when the host is known and too small on some axis. */
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

/** The highest memory (bytes) and CPU (% of one core) in a metrics window. */
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

/**
 * The size to suggest for a peak: the smallest preset with 1.5x headroom on both
 * axes, else twice the peak rounded up; null when the host cannot give headroom.
 */
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

/** "256 MB" / "1 GB" / "1.5 GB" in the form's own unit. */
export function fmtMemMb(mb: number): string {
  return mb >= 1024 ? `${Number((mb / 1024).toFixed(2))} GB` : `${mb} MB`;
}

/** "0.5 CPU" / "1 CPU" / "2 CPUs". */
export function fmtCpu(cores: number): string {
  const n = Number(cores.toFixed(2));
  return `${n} CPU${n > 1 ? "s" : ""}`;
}
