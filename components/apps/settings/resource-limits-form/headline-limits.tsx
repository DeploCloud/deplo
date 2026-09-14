"use client";

import {
  type ResourceLimitsForm as FormState,
  type ResourceSize,
  suggestedSize,
  fmtMemMb,
  fmtCpu,
} from "@/lib/apps/resource-limits-model";
import { cn, formatBytes } from "@/lib/utils";
import { LimitCell, LimitInput } from "./limit-fields";
import { HostSummaryCell, type HostInfo } from "./host-capacity";
import { Meter } from "./usage-meter";
import type { LiveUsage } from "./use-live-usage";

const MIB = 1048576;

const capLine = (cap: string | null, full: string | null) =>
  cap && full
    ? `${cap} of ${full}`
    : cap
      ? cap
      : full
        ? `No limit of ${full}`
        : "No limit";

const usageLine = (usage: LiveUsage, used: string, peakStr: string) =>
  usage.samples.length === 0
    ? null
    : usage.current
      ? `Using ${used} · peak ${peakStr}`
      : usage.peak
        ? `Not running · peak ${peakStr}`
        : "Not running";

function CapCaptions({
  usage,
  cap,
  full,
  used,
  peakText,
}: {
  usage: LiveUsage;
  cap: string | null;
  full: string | null;
  used: string;
  peakText: string;
}) {
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <p>{capLine(cap, full)}</p>
      <p>{usageLine(usage, used, peakText)}</p>
    </div>
  );
}

// HeadlineLimits is the Memory + CPU row: the caps, their meters and the host panel.
export function HeadlineLimits({
  form,
  set,
  hostCap,
  usage,
  noun,
  onApplySuggestion,
}: {
  form: FormState;
  set: (k: keyof FormState) => (v: string) => void;
  hostCap: HostInfo | null;
  usage: LiveUsage;
  noun: string;
  onApplySuggestion: (size: ResourceSize) => void;
}) {
  const { peak, last, current } = usage;
  const memCap = Number(form.memoryMb) > 0 ? Number(form.memoryMb) : null;
  const cpuCap = Number(form.cpuCores) > 0 ? Number(form.cpuCores) : null;
  const suggestion = peak ? suggestedSize(peak, hostCap) : null;
  const suggestionIsCurrent =
    suggestion != null &&
    memCap === suggestion.memoryMb &&
    cpuCap === suggestion.cpuCores;
  const memBelowPeak = memCap != null && peak != null && memCap < peak.memoryMb;
  const cpuBelowPeak = cpuCap != null && peak != null && cpuCap < peak.cpuCores;
  const showSuggestion = suggestion != null && !suggestionIsCurrent;
  const sideCell = hostCap != null || showSuggestion;

  return (
    <div
      className={cn("grid gap-3 sm:grid-cols-2", sideCell && "lg:grid-cols-3")}
    >
      <LimitCell
        id="limit-memory"
        label="Memory limit"
        info="Hard RAM ceiling. The container is restarted (OOM-killed) if it exceeds this. In MB - 1024 = 1 GB, 2048 = 2 GB."
        docs="resources.core"
        input={
          <LimitInput
            id="limit-memory"
            unit="MB"
            min={6}
            placeholder="No limit"
            value={form.memoryMb}
            onChange={set("memoryMb")}
          />
        }
      >
        {hostCap && hostCap.memoryMb > 0 && (
          <Meter
            cap={memCap}
            used={current ? current.memUsed / MIB : null}
            full={hostCap.memoryMb}
            step={128}
            label="Memory limit"
            valueText={memCap != null ? fmtMemMb(memCap) : "No limit"}
            onChange={(v) => set("memoryMb")(v ? String(v) : "")}
          />
        )}
        <CapCaptions
          usage={usage}
          cap={memCap != null ? fmtMemMb(memCap) : null}
          full={
            hostCap && hostCap.memoryMb > 0 ? fmtMemMb(hostCap.memoryMb) : null
          }
          used={formatBytes(last?.memUsed ?? 0)}
          peakText={formatBytes((peak?.memoryMb ?? 0) * MIB)}
        />
        {memBelowPeak && (
          <p className="text-xs text-warning">
            Below the recent peak - the container would be killed at this size.
          </p>
        )}
      </LimitCell>

      <LimitCell
        id="limit-cpu"
        label="CPU limit"
        info="Maximum CPU cores. 0.5 = half a core, 2 = two cores. Fractions allowed."
        docs="resources.core"
        input={
          <LimitInput
            id="limit-cpu"
            unit="cores"
            min={0}
            step={0.1}
            placeholder="No limit"
            value={form.cpuCores}
            onChange={set("cpuCores")}
          />
        }
      >
        {hostCap && hostCap.cpuCores > 0 && (
          <Meter
            cap={cpuCap}
            used={current ? current.cpu / 100 : null}
            full={hostCap.cpuCores}
            step={0.25}
            label="CPU limit"
            valueText={cpuCap != null ? fmtCpu(cpuCap) : "No limit"}
            onChange={(v) => set("cpuCores")(v ? String(v) : "")}
          />
        )}
        <CapCaptions
          usage={usage}
          cap={cpuCap != null ? fmtCpu(cpuCap) : null}
          full={
            hostCap && hostCap.cpuCores > 0 ? fmtCpu(hostCap.cpuCores) : null
          }
          used={fmtCpu((last?.cpu ?? 0) / 100)}
          peakText={fmtCpu(peak?.cpuCores ?? 0)}
        />
        {cpuBelowPeak && (
          <p className="text-xs text-warning">
            Below the recent peak - the {noun} would be throttled.
          </p>
        )}
      </LimitCell>

      {sideCell && (
        <HostSummaryCell
          hostCap={hostCap}
          suggestion={showSuggestion ? suggestion : null}
          peak={peak}
          onApplySuggestion={onApplySuggestion}
        />
      )}
    </div>
  );
}
