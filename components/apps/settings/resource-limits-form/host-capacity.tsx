"use client";

import { Server, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  type ResourceLimitsForm as FormState,
  type ResourceSize,
  RESOURCE_PRESETS,
  activeResourcePreset,
  sizeFitsHost,
  fmtMemMb,
  fmtCpu,
} from "@/lib/apps/resource-limits-model";
import { cn } from "@/lib/utils";

export interface HostInfo extends ResourceSize {
  name: string;
}

function SizeTile({
  label,
  sub,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  sub: string[];
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex h-full w-full flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        selected
          ? "border-primary bg-primary-wash ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20",
      )}
    >
      <span className="text-sm font-medium">{label}</span>
      {sub.map((line) => (
        <span
          key={line}
          className="text-xs whitespace-nowrap text-muted-foreground"
        >
          {line}
        </span>
      ))}
    </button>
  );
}

export function SizeTiles({
  form,
  hostCap,
  onSelect,
}: {
  form: FormState;
  hostCap: HostInfo | null;
  onSelect: (size: ResourceSize | null) => void;
}) {
  const uncapped = form.memoryMb === "" && form.cpuCores === "";
  const activePreset = activeResourcePreset(form);
  return (
    <div
      role="radiogroup"
      aria-label="Size"
      className="grid grid-cols-3 gap-2 sm:grid-cols-6"
    >
      <SizeTile
        label="No limit"
        sub={["Uncapped"]}
        selected={uncapped}
        onSelect={() => onSelect(null)}
      />
      {RESOURCE_PRESETS.map((p) => {
        const fits = sizeFitsHost(p, hostCap);
        const tile = (
          <SizeTile
            key={p.label}
            label={p.label}
            sub={[fmtMemMb(p.memoryMb), fmtCpu(p.cpuCores)]}
            selected={activePreset?.label === p.label}
            disabled={!fits}
            onSelect={() => onSelect(p)}
          />
        );
        if (fits) return tile;
        return (
          <SimpleTooltip
            key={p.label}
            content={`${hostCap!.name} has ${fmtMemMb(hostCap!.memoryMb)} and ${fmtCpu(hostCap!.cpuCores)}`}
          >
            <span className="block">{tile}</span>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}

export function HostSummaryCell({
  hostCap,
  suggestion,
  peak,
  onApplySuggestion,
}: {
  hostCap: HostInfo | null;
  suggestion: (ResourceSize & { label: string }) | null;
  peak: ResourceSize | null;
  onApplySuggestion: (size: ResourceSize) => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border p-4 sm:col-span-2 lg:col-span-1",
        suggestion != null && "deplo-brand-wash",
      )}
    >
      {hostCap && (
        <div className="flex items-center gap-2 text-sm">
          <Server className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{hostCap.name}</span>
          <span className="shrink-0 text-muted-foreground">
            {fmtMemMb(hostCap.memoryMb)} · {fmtCpu(hostCap.cpuCores)}
          </span>
        </div>
      )}
      {suggestion ? (
        <div className="mt-auto flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-0.5">
            <p className="flex items-center gap-2 text-sm">
              <Sparkles className="size-4 shrink-0" />
              <span>
                Suggested:{" "}
                <span className="font-medium">
                  {suggestion.label} · {fmtMemMb(suggestion.memoryMb)},{" "}
                  {fmtCpu(suggestion.cpuCores)}
                </span>
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              1.5x the peak of the last 15 minutes.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => onApplySuggestion(suggestion)}
          >
            Apply
          </Button>
        </div>
      ) : (
        peak && (
          <p className="mt-auto text-xs text-muted-foreground">
            Fits the peak of the last 15 minutes.
          </p>
        )
      )}
    </div>
  );
}
