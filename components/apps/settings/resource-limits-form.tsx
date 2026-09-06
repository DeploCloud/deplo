"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "@/lib/nav";
import {
  Save,
  RotateCcw,
  Cpu,
  MemoryStick,
  HardDrive,
  Layers,
  Gauge,
  Server,
  Sparkles,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { DocsTopic } from "@/lib/docs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import type { ResourceLimits } from "@/lib/types";
import {
  type ResourceLimitsForm as FormState,
  type ResourceSize,
  EMPTY_RESOURCE_FORM,
  resourcesToForm,
  formToLimitsInput,
  serializeResourceForm,
  RESOURCE_PRESETS,
  activeResourcePreset,
  sizeFitsHost,
  usagePeak,
  suggestedSize,
  fmtMemMb,
  fmtCpu,
} from "@/lib/apps/resource-limits-model";
import { gqlAction } from "@/lib/graphql-client";
import { cn, formatBytes } from "@/lib/utils";

// https://deplo.build/docs/advanced/resource-limits

/** One buffered metrics sample - the slice of `ContainerMetricsSample` read here. */
export interface UsageSample {
  ts: number;
  online: boolean;
  cpu: number;
  memUsed: number;
  running: number;
}

/** The owning machine: its name for the captions, its size for the bars. */
export interface HostInfo extends ResourceSize {
  name: string;
}

const POLL_MS = 5_000;
const MIB = 1048576;

const ADVANCED_KEYS: (keyof FormState)[] = [
  "memoryReservationMb",
  "swapMb",
  "cpuShares",
  "cpuset",
  "pidsLimit",
  "nofile",
  "nproc",
  "shmSizeMb",
  "storageGb",
  "oomScoreAdj",
];

function LimitInput({
  id,
  value,
  onChange,
  unit,
  placeholder,
  min,
  step,
  type = "number",
  className,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  placeholder?: string;
  min?: number;
  step?: number;
  type?: "number" | "text";
  className?: string;
}) {
  return (
    <div className={cn("relative w-32 shrink-0", className)}>
      <Input
        id={id}
        type={type}
        inputMode={type === "number" ? "decimal" : undefined}
        min={min}
        step={step}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          unit && "pr-14",
        )}
      />
      {unit && (
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-xs font-medium text-muted-foreground">
          {unit}
        </span>
      )}
    </div>
  );
}

/** A label on the left, its input on the right: one limit per line. */
function LimitRow({
  id,
  label,
  info,
  docs,
  children,
  note,
}: {
  id: string;
  label: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <FieldLabel
          htmlFor={id}
          info={info}
          docs={docs}
          className="whitespace-nowrap"
        >
          {label}
        </FieldLabel>
        {children}
      </div>
      {note}
    </div>
  );
}

function LimitGroup({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={title}
      className="rounded-lg border border-border px-4 py-3"
    >
      <p className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        <Icon className="size-3.5" />
        {title}
      </p>
      <div className="mt-1 divide-y divide-border">{children}</div>
    </div>
  );
}

/** A headline limit: label and input on top, the slider and its readings under. */
function LimitCell({
  id,
  label,
  info,
  docs,
  input,
  children,
}: {
  id: string;
  label: string;
  info: React.ReactNode;
  docs?: DocsTopic;
  input: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FieldLabel
          htmlFor={id}
          info={info}
          docs={docs}
          className="whitespace-nowrap"
        >
          {label}
        </FieldLabel>
        {input}
      </div>
      {children}
    </div>
  );
}

/** Thumb size, in px: the track is inset by half of it so the cap segment ends
 *  exactly under the thumb. */
const THUMB = 16;

/** The cap against the whole machine, draggable, with what is used drawn over it. */
function Meter({
  cap,
  used,
  full,
  step,
  label,
  valueText,
  onChange,
}: {
  cap: number | null;
  used: number | null;
  full: number;
  step: number;
  label: string;
  valueText: string;
  /** 0 means "no limit". */
  onChange: (value: number) => void;
}) {
  const pct = (n: number) => `${Math.min(100, (n / full) * 100)}%`;
  const overCap = cap != null && used != null && used > cap;
  return (
    <div className="relative flex h-4 items-center">
      <div
        className="relative h-2 flex-1 overflow-hidden rounded-full bg-secondary"
        style={{ marginInline: THUMB / 2 }}
      >
        {cap != null && (
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              cap > full ? "bg-warning" : "bg-primary",
            )}
            style={{ width: pct(cap) }}
          />
        )}
        {used != null && used > 0 && (
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full transition-[width]",
              overCap ? "bg-warning" : "bg-muted-foreground",
            )}
            style={{ width: pct(used) }}
          />
        )}
      </div>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={valueText}
        min={0}
        max={full}
        step={step}
        value={Math.min(full, cap ?? 0)}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          "absolute inset-0 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none disabled:cursor-not-allowed",
          "[&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent",
          "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm",
          "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-sm",
          "[&:focus-visible::-moz-range-thumb]:ring-2 [&:focus-visible::-moz-range-thumb]:ring-ring [&:focus-visible::-webkit-slider-thumb]:ring-2 [&:focus-visible::-webkit-slider-thumb]:ring-ring",
        )}
      />
    </div>
  );
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

export function ResourceLimitsForm({
  kind,
  id,
  slug,
  resources,
  isComposeStack = false,
  host,
  usage,
  canRedeploy,
  canProtectFromOom,
}: {
  kind: "app" | "database";
  id: string;
  /** App only: where the deploy the toast starts is followed to. */
  slug?: string;
  resources: ResourceLimits | null;
  isComposeStack?: boolean;
  host: HostInfo | null;
  /** The buffered window; null when the viewer cannot see metrics. */
  usage: UsageSample[] | null;
  canRedeploy: boolean;
  /** A negative OOM priority reaches other tenants, so it needs the grant. */
  canProtectFromOom: boolean;
}) {
  const router = useRouter();
  const noun = kind === "app" ? "app" : "database";
  const [form, setForm] = React.useState<FormState>(() =>
    resourcesToForm(resources),
  );
  const [pending, startTransition] = React.useTransition();
  const [savedKey, setSavedKey] = React.useState(() =>
    serializeResourceForm(resourcesToForm(resources)),
  );
  const dirty = serializeResourceForm(form) !== savedKey;

  const set = (k: keyof FormState) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setSize = (s: ResourceSize | null) =>
    setForm((f) => ({
      ...f,
      memoryMb: s ? String(s.memoryMb) : "",
      cpuCores: s ? String(s.cpuCores) : "",
    }));

  /* ---- live usage ---- */
  const [samples, setSamples] = React.useState<UsageSample[]>(() =>
    (usage ?? []).filter((s) => s.online),
  );
  const historyField =
    kind === "app" ? "appMetricsHistory" : "databaseMetricsHistory";
  const idArg = kind === "app" ? "appId" : "databaseId";
  React.useEffect(() => {
    if (!usage) return;
    let active = true;
    const read = async () => {
      if (document.visibilityState === "hidden") return;
      const res = await gqlAction<Record<string, UsageSample[]>, UsageSample[]>(
        `query($id: String!) {
           ${historyField}(${idArg}: $id) { ts online cpu memUsed running }
         }`,
        { id },
        (d) => d[historyField] ?? [],
      );
      if (!active || !res.ok || !res.data?.length) return;
      setSamples(res.data.filter((s) => s.online));
    };
    const iv = setInterval(read, POLL_MS);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [usage, id, historyField, idArg]);

  const peak = React.useMemo(() => usagePeak(samples), [samples]);
  const last = samples[samples.length - 1];
  const current = last && last.running > 0 ? last : null;

  /* ---- derived ---- */
  const hostCap =
    host && (host.memoryMb > 0 || host.cpuCores > 0) ? host : null;
  const memCap = Number(form.memoryMb) > 0 ? Number(form.memoryMb) : null;
  const cpuCap = Number(form.cpuCores) > 0 ? Number(form.cpuCores) : null;
  const activePreset = activeResourcePreset(form);
  const uncapped = form.memoryMb === "" && form.cpuCores === "";
  const suggestion = peak ? suggestedSize(peak, hostCap) : null;
  const suggestionIsCurrent =
    suggestion != null &&
    memCap === suggestion.memoryMb &&
    cpuCap === suggestion.cpuCores;
  const hasAdvanced = ADVANCED_KEYS.some((k) => form[k] !== "");
  const oomNegative = Number(form.oomScoreAdj) < 0;

  /* ---- actions ---- */
  function applyNow() {
    startTransition(async () => {
      if (kind === "app") {
        const res = await gqlAction<
          { redeploy: { id: string | null } | null },
          { id: string | null } | null
        >(
          `mutation($appId: String!) { redeploy(appId: $appId) { id } }`,
          { appId: id },
          (d) => d.redeploy,
        );
        if (!res.ok) return void toast.error(res.error);
        toast.success("Deploy started");
        if (res.data?.id && slug)
          router.push(`/apps/${slug}/deployments/${res.data.id}`);
        else router.refresh();
      } else {
        const res = await gqlAction(
          `mutation($id: String!) { redeployDatabase(id: $id) { id } }`,
          { id },
        );
        if (!res.ok) return void toast.error(res.error);
        toast.success("Database redeployed");
        router.refresh();
      }
    });
  }

  function save() {
    const committed = serializeResourceForm(form);
    const mutation =
      kind === "app" ? "updateAppResources" : "updateDatabaseResources";
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $limits: ResourceLimitsInput!) {
           ${mutation}(id: $id, limits: $limits) { id }
         }`,
        { id, limits: formToLimitsInput(form) },
      );
      if (!res.ok) return void toast.error(res.error);
      setSavedKey(committed);
      router.refresh();
      toast.success(
        kind === "app"
          ? "Resource limits saved - applied on the next deploy"
          : "Resource limits saved - Redeploy to apply",
        canRedeploy
          ? {
              action: {
                label: kind === "app" ? "Deploy now" : "Redeploy now",
                onClick: applyNow,
              },
            }
          : undefined,
      );
    });
  }

  const clearDisabled =
    pending ||
    serializeResourceForm(form) === serializeResourceForm(EMPTY_RESOURCE_FORM);

  /* ---- captions ---- */
  const usageLine = (used: string, peakStr: string) =>
    samples.length === 0
      ? null
      : current
        ? `Using ${used} · peak ${peakStr}`
        : peak
          ? `Not running · peak ${peakStr}`
          : "Not running";
  const capLine = (cap: string | null, full: string | null) =>
    cap && full
      ? `${cap} of ${full}`
      : cap
        ? cap
        : full
          ? `No limit of ${full}`
          : "No limit";

  const memBelowPeak = memCap != null && peak != null && memCap < peak.memoryMb;
  const cpuBelowPeak = cpuCap != null && peak != null && cpuCap < peak.cpuCores;
  const showSuggestion = suggestion != null && !suggestionIsCurrent;
  const sideCell = hostCap != null || showSuggestion;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4 text-muted-foreground" />
            Resource limits
          </CardTitle>
          <CardDescription>
            {isComposeStack ? (
              <>
                Cap how much of the host each service of this stack can use.
                Empty means no limit; a service&apos;s own compose limit wins.
              </>
            ) : (
              <>
                Cap how much of the host this {noun} can use. Empty means no
                limit.
              </>
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          {/* One click sets Memory + CPU together. */}
          <div
            role="radiogroup"
            aria-label="Size"
            className="grid grid-cols-3 gap-2 sm:grid-cols-6"
          >
            <SizeTile
              label="No limit"
              sub={["Uncapped"]}
              selected={uncapped}
              onSelect={() => setSize(null)}
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
                  onSelect={() => setSize(p)}
                />
              );
              if (fits) return tile;
              return (
                <SimpleTooltip
                  key={p.label}
                  content={`${host!.name} has ${fmtMemMb(host!.memoryMb)} and ${fmtCpu(host!.cpuCores)}`}
                >
                  <span className="block">{tile}</span>
                </SimpleTooltip>
              );
            })}
          </div>

          <div
            className={cn(
              "grid gap-3 sm:grid-cols-2",
              sideCell && "lg:grid-cols-3",
            )}
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
              <div className="space-y-0.5 text-xs text-muted-foreground">
                <p>
                  {capLine(
                    memCap != null ? fmtMemMb(memCap) : null,
                    hostCap && hostCap.memoryMb > 0
                      ? fmtMemMb(hostCap.memoryMb)
                      : null,
                  )}
                </p>
                <p>
                  {usageLine(
                    formatBytes(last?.memUsed ?? 0),
                    formatBytes((peak?.memoryMb ?? 0) * MIB),
                  )}
                </p>
              </div>
              {memBelowPeak && (
                <p className="text-xs text-warning">
                  Below the recent peak - the container would be killed at this
                  size.
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
              <div className="space-y-0.5 text-xs text-muted-foreground">
                <p>
                  {capLine(
                    cpuCap != null ? fmtCpu(cpuCap) : null,
                    hostCap && hostCap.cpuCores > 0
                      ? fmtCpu(hostCap.cpuCores)
                      : null,
                  )}
                </p>
                <p>
                  {usageLine(
                    fmtCpu((last?.cpu ?? 0) / 100),
                    fmtCpu(peak?.cpuCores ?? 0),
                  )}
                </p>
              </div>
              {cpuBelowPeak && (
                <p className="text-xs text-warning">
                  Below the recent peak - the {noun} would be throttled.
                </p>
              )}
            </LimitCell>

            {sideCell && (
              <div className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:col-span-2 lg:col-span-1">
                {hostCap && (
                  <div className="flex items-center gap-2 text-sm">
                    <Server className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{host!.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {fmtMemMb(hostCap.memoryMb)} · {fmtCpu(hostCap.cpuCores)}
                    </span>
                  </div>
                )}
                {showSuggestion ? (
                  <div className="mt-auto flex flex-wrap items-end justify-between gap-3">
                    <div className="space-y-0.5">
                      <p className="flex items-center gap-2 text-sm">
                        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
                        <span>
                          Suggested:{" "}
                          <span className="font-medium">
                            {suggestion.label} · {fmtMemMb(suggestion.memoryMb)}
                            , {fmtCpu(suggestion.cpuCores)}
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
                      variant="outline"
                      onClick={() => setSize(suggestion)}
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
            )}
          </div>

          <Accordion
            type="single"
            collapsible
            defaultValue={hasAdvanced ? "advanced" : undefined}
            className="border-t border-border"
          >
            <AccordionItem value="advanced" className="border-none">
              <AccordionTrigger className="text-sm hover:no-underline">
                Advanced limits
              </AccordionTrigger>
              <AccordionContent className="pt-1">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <LimitGroup icon={MemoryStick} title="Memory">
                    <LimitRow
                      id="limit-mem-reservation"
                      label="Memory reservation"
                      info="Soft RAM floor the scheduler tries to keep available for this app under contention. Must be ≤ the memory limit."
                      docs="resources.advanced"
                    >
                      <LimitInput
                        id="limit-mem-reservation"
                        unit="MB"
                        min={6}
                        placeholder="e.g. 256"
                        value={form.memoryReservationMb}
                        onChange={set("memoryReservationMb")}
                      />
                    </LimitRow>
                    <LimitRow
                      id="limit-swap"
                      label="Swap limit"
                      info="Total memory + swap ceiling. Needs a memory limit set, and must be ≥ it (the difference is how much swap the app may use)."
                      docs="resources.advanced"
                    >
                      <LimitInput
                        id="limit-swap"
                        unit="MB"
                        min={6}
                        placeholder="e.g. 1024"
                        value={form.swapMb}
                        onChange={set("swapMb")}
                      />
                    </LimitRow>
                  </LimitGroup>

                  <LimitGroup icon={Cpu} title="CPU">
                    <LimitRow
                      id="limit-cpu-shares"
                      label="CPU shares"
                      info="Relative CPU weight when the host is busy (default 1024) - 2048 gets twice the share of 1024. Doesn't cap idle-time usage."
                      docs="resources.advanced"
                    >
                      <LimitInput
                        id="limit-cpu-shares"
                        unit="weight"
                        min={2}
                        placeholder="1024"
                        value={form.cpuShares}
                        onChange={set("cpuShares")}
                      />
                    </LimitRow>
                    <LimitRow
                      id="limit-cpuset"
                      label="CPU pinning"
                      info='Pin the app to specific host cores, e.g. "0", "0,1" or "0-3". Leave empty to run on any core.'
                      docs="resources.advanced"
                    >
                      <LimitInput
                        id="limit-cpuset"
                        type="text"
                        placeholder="e.g. 0,2-3"
                        value={form.cpuset}
                        onChange={set("cpuset")}
                      />
                    </LimitRow>
                  </LimitGroup>

                  <LimitGroup icon={Layers} title="Processes & files">
                    <LimitRow
                      id="limit-pids"
                      label="Process limit"
                      info="Maximum number of processes/threads the container may spawn - a guard against fork bombs and runaway workers."
                      docs="resources.advanced"
                    >
                      <LimitInput
                        id="limit-pids"
                        unit="count"
                        min={1}
                        placeholder="e.g. 512"
                        value={form.pidsLimit}
                        onChange={set("pidsLimit")}
                      />
                    </LimitRow>
                    <LimitRow
                      id="limit-nofile"
                      label="Open files"
                      info="Maximum open file descriptors (ulimit nofile). Raise it for high-connection servers hitting 'too many open files'."
                      docs="resources.advanced"
                    >
                      <LimitInput
                        id="limit-nofile"
                        unit="count"
                        min={1}
                        placeholder="e.g. 1024"
                        value={form.nofile}
                        onChange={set("nofile")}
                      />
                    </LimitRow>
                    <LimitRow
                      id="limit-nproc"
                      label="User processes"
                      info="Per-user process ceiling (ulimit nproc). Usually redundant with the process limit above."
                      docs="resources.advanced"
                    >
                      <LimitInput
                        id="limit-nproc"
                        unit="count"
                        min={1}
                        placeholder="e.g. 512"
                        value={form.nproc}
                        onChange={set("nproc")}
                      />
                    </LimitRow>
                  </LimitGroup>

                  <LimitGroup icon={HardDrive} title="Storage">
                    <LimitRow
                      id="limit-shm"
                      label="Shared memory"
                      info="Size of /dev/shm (shared-memory segment). Default is 64 MB; raise it for apps that need more (some databases, Chromium/Puppeteer)."
                      docs="resources.advanced"
                    >
                      <LimitInput
                        id="limit-shm"
                        unit="MB"
                        min={1}
                        placeholder="e.g. 64"
                        value={form.shmSizeMb}
                        onChange={set("shmSizeMb")}
                      />
                    </LimitRow>
                    <LimitRow
                      id="limit-storage"
                      label="Disk quota"
                      info="Caps the writable layer, not Volume storage. Needs host support (XFS + pquota or devicemapper) or the deploy is rejected."
                      docs="resources.advanced"
                    >
                      <LimitInput
                        id="limit-storage"
                        unit="GB"
                        min={1}
                        placeholder="e.g. 10"
                        value={form.storageGb}
                        onChange={set("storageGb")}
                      />
                    </LimitRow>
                  </LimitGroup>

                  <LimitGroup icon={Gauge} title="Under memory pressure">
                    <LimitRow
                      id="limit-oom"
                      label="OOM priority"
                      info={
                        canProtectFromOom
                          ? "Range -1000 to 1000. If the host runs out of memory, higher scores are killed first - negative protects this app."
                          : "Range -1000 to 1000. Higher scores are killed first when the host runs out of memory. Negative needs the host-volumes grant."
                      }
                      docs="resources.advanced"
                      note={
                        oomNegative &&
                        !canProtectFromOom && (
                          <p className="mt-1.5 text-xs text-destructive">
                            Negative values need the host-volumes grant.
                          </p>
                        )
                      }
                    >
                      <LimitInput
                        id="limit-oom"
                        unit="score"
                        min={canProtectFromOom ? -1000 : 0}
                        placeholder="0"
                        value={form.oomScoreAdj}
                        onChange={set("oomScoreAdj")}
                      />
                    </LimitRow>
                  </LimitGroup>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>

        <CardFooter className="justify-between border-t border-border pt-4">
          <DirtyHint dirty={dirty} />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setForm({ ...EMPTY_RESOURCE_FORM })}
              disabled={clearDisabled}
            >
              <RotateCcw className="size-4" />
              Clear all
            </Button>
            <Button size="sm" onClick={save} disabled={pending || !dirty}>
              <Save className="size-4" />
              Save limits
            </Button>
          </div>
        </CardFooter>
      </Card>

      <UnsavedChangesGuard when={dirty} />
    </>
  );
}
