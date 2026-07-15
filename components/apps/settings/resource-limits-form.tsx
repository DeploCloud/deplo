"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import {
  Save,
  RotateCcw,
  Cpu,
  MemoryStick,
  HardDrive,
  Layers,
  Gauge,
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
  EMPTY_RESOURCE_FORM,
  resourcesToForm,
  formToLimitsInput,
  serializeResourceForm,
  RESOURCE_PRESETS,
  activeResourcePreset,
} from "@/lib/apps/resource-limits-model";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

/**
 * Resources settings: per-app caps on RAM / CPU / processes / disk, applied to
 * the app's container(s) on the next deploy (baked into the rendered compose,
 * like volumes). The two everyone reaches for — Memory and CPU — sit in the main
 * card with quick-pick sizes; the rest live under "Advanced limits" so the happy
 * path stays a two-field decision and no Docker knowledge is required.
 *
 * A compose-stack app keeps the same form, but the caps apply to EACH service
 * that doesn't set its own limit (a multi-service stack has no host-level
 * aggregate cgroup) — surfaced as a note rather than hidden, so the feature
 * still works for stacks.
 */

/**
 * A labelled numeric/text field. The input fills its column and the unit rides
 * inside it as a right-aligned suffix (native number spinners are hidden so they
 * never collide with it) — so fields read cleanly at any width instead of tiny
 * boxes floating in empty space.
 */
function LimitField({
  label,
  info,
  value,
  onChange,
  unit,
  placeholder,
  min,
  step,
  type = "number",
}: {
  label: string;
  info: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  placeholder?: string;
  min?: number;
  step?: number;
  type?: "number" | "text";
}) {
  return (
    <div className="space-y-2">
      <FieldLabel info={info}>{label}</FieldLabel>
      <div className="relative">
        <Input
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
    </div>
  );
}

/** A titled group of limit fields laid out in a responsive grid. */
function LimitGroup({
  icon: Icon,
  title,
  cols = 2,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  /** Widest column count on large screens (2 by default, 3 for denser groups). */
  cols?: 2 | 3;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {title}
      </legend>
      <div
        className={cn(
          "grid gap-x-4 gap-y-5 sm:grid-cols-2",
          cols === 3 && "lg:grid-cols-3",
        )}
      >
        {children}
      </div>
    </fieldset>
  );
}

export function ResourceLimitsForm({
  appId,
  resources,
  isComposeStack,
}: {
  appId: string;
  resources: ResourceLimits | null;
  isComposeStack: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(() => resourcesToForm(resources));
  const [pending, startTransition] = React.useTransition();

  const [savedKey, setSavedKey] = React.useState(() =>
    serializeResourceForm(resourcesToForm(resources)),
  );
  const dirty = serializeResourceForm(form) !== savedKey;

  const set = (k: keyof FormState) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const activePreset = activeResourcePreset(form);

  function applyPreset(p: (typeof RESOURCE_PRESETS)[number]) {
    setForm((f) => ({ ...f, memoryMb: String(p.memoryMb), cpuCores: String(p.cpuCores) }));
  }

  function save() {
    const committed = serializeResourceForm(form);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $limits: ResourceLimitsInput!) {
           updateAppResources(id: $id, limits: $limits) { id }
         }`,
        { id: appId, limits: formToLimitsInput(form) },
      );
      if (res.ok) {
        setSavedKey(committed);
        router.refresh();
        toast.success("Resource limits saved — applied on the next deploy");
      } else toast.error(res.error);
    });
  }

  const clearDisabled =
    pending ||
    serializeResourceForm(form) === serializeResourceForm(EMPTY_RESOURCE_FORM);

  return (
    <>
      {isComposeStack && (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          This app deploys a compose stack, so these caps apply to{" "}
          <strong className="font-medium text-foreground">each service</strong>{" "}
          that doesn&apos;t already set its own limit in the compose file.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4 text-muted-foreground" />
            Resource limits
          </CardTitle>
          <CardDescription>
            Cap how much of the host this app can use. Leave a field empty to
            leave that resource uncapped. Applied on the next deploy.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-8">
          {/* Quick-pick sizes fill Memory + CPU together. */}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Quick size
            </p>
            <div className="flex flex-wrap gap-2">
              {RESOURCE_PRESETS.map((p) => {
                const active = activePreset?.label === p.label;
                return (
                  <Button
                    key={p.label}
                    type="button"
                    variant={active ? "default" : "outline"}
                    onClick={() => applyPreset(p)}
                    className="h-auto flex-col items-start gap-0.5 px-3 py-1.5"
                  >
                    <span className="text-sm font-medium leading-none">
                      {p.label}
                    </span>
                    <span
                      className={cn(
                        "text-[11px] leading-none",
                        active ? "opacity-80" : "text-muted-foreground",
                      )}
                    >
                      {p.cpuCores} CPU ·{" "}
                      {p.memoryMb >= 1024
                        ? `${p.memoryMb / 1024} GB`
                        : `${p.memoryMb} MB`}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Headline: the two fields everyone reaches for. */}
          <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
            <LimitField
              label="Memory limit"
              unit="MB"
              min={6}
              placeholder="e.g. 512"
              value={form.memoryMb}
              onChange={set("memoryMb")}
              info="Hard RAM ceiling. The container is restarted (OOM-killed) if it exceeds this. In MB — 1024 = 1 GB, 2048 = 2 GB."
            />
            <LimitField
              label="CPU limit"
              unit="cores"
              min={0}
              step={0.1}
              placeholder="e.g. 0.5"
              value={form.cpuCores}
              onChange={set("cpuCores")}
              info="Maximum CPU cores. 0.5 = half a core, 2 = two cores. Fractions allowed."
            />
          </div>

          {/* Everything else, folded away so the happy path is two fields. */}
          <Accordion type="single" collapsible className="border-t border-border">
            <AccordionItem value="advanced" className="border-none">
              <AccordionTrigger className="text-sm hover:no-underline">
                Advanced limits
              </AccordionTrigger>
              <AccordionContent className="space-y-7 pt-2">
                <LimitGroup icon={MemoryStick} title="Memory">
                  <LimitField
                    label="Memory reservation"
                    unit="MB"
                    min={6}
                    placeholder="e.g. 256"
                    value={form.memoryReservationMb}
                    onChange={set("memoryReservationMb")}
                    info="Soft RAM floor the scheduler tries to keep available for this app under contention. Must be ≤ the memory limit."
                  />
                  <LimitField
                    label="Swap limit"
                    unit="MB"
                    min={6}
                    placeholder="e.g. 1024"
                    value={form.swapMb}
                    onChange={set("swapMb")}
                    info="Total memory + swap ceiling. Needs a memory limit set, and must be ≥ it (the difference is how much swap the app may use)."
                  />
                </LimitGroup>

                <LimitGroup icon={Cpu} title="CPU">
                  <LimitField
                    label="CPU shares"
                    unit="weight"
                    min={2}
                    placeholder="1024"
                    value={form.cpuShares}
                    onChange={set("cpuShares")}
                    info="Relative CPU weight when the host is busy (default 1024). An app with 2048 gets twice the CPU of one with 1024. Doesn't cap idle-time usage."
                  />
                  <LimitField
                    label="CPU pinning"
                    type="text"
                    placeholder="e.g. 0,2-3"
                    value={form.cpuset}
                    onChange={set("cpuset")}
                    info='Pin the app to specific host cores, e.g. "0", "0,1" or "0-3". Leave empty to run on any core.'
                  />
                </LimitGroup>

                <LimitGroup icon={Layers} title="Processes & files" cols={3}>
                  <LimitField
                    label="Process limit"
                    unit="count"
                    min={1}
                    placeholder="e.g. 512"
                    value={form.pidsLimit}
                    onChange={set("pidsLimit")}
                    info="Maximum number of processes/threads the container may spawn — a guard against fork bombs and runaway workers."
                  />
                  <LimitField
                    label="Open files"
                    unit="count"
                    min={1}
                    placeholder="e.g. 1024"
                    value={form.nofile}
                    onChange={set("nofile")}
                    info="Maximum open file descriptors (ulimit nofile). Raise it for high-connection servers hitting 'too many open files'."
                  />
                  <LimitField
                    label="User processes"
                    unit="count"
                    min={1}
                    placeholder="e.g. 512"
                    value={form.nproc}
                    onChange={set("nproc")}
                    info="Maximum processes for the container's user (ulimit nproc). Usually leave to the process limit above; set only if you need the per-user ulimit specifically."
                  />
                </LimitGroup>

                <LimitGroup icon={HardDrive} title="Storage">
                  <LimitField
                    label="Shared memory"
                    unit="MB"
                    min={1}
                    placeholder="e.g. 64"
                    value={form.shmSizeMb}
                    onChange={set("shmSizeMb")}
                    info="Size of /dev/shm (shared-memory segment). Default is 64 MB; raise it for apps that need more (some databases, Chromium/Puppeteer)."
                  />
                  <LimitField
                    label="Disk quota"
                    unit="GB"
                    min={1}
                    placeholder="e.g. 10"
                    value={form.storageGb}
                    onChange={set("storageGb")}
                    info="⚠ Hard cap on the container's writable-layer disk usage. Requires host support (XFS + pquota, or the devicemapper driver); on other hosts the deploy is rejected. Leave empty unless you know your host supports it — this does not limit named volumes."
                  />
                </LimitGroup>

                <LimitGroup icon={Gauge} title="Under memory pressure">
                  <LimitField
                    label="OOM priority"
                    unit="score"
                    min={-1000}
                    placeholder="0"
                    value={form.oomScoreAdj}
                    onChange={set("oomScoreAdj")}
                    info="Range −1000…1000. When the whole host runs out of memory, containers with a higher score are killed first. Use a negative value to protect this app, positive to sacrifice it first."
                  />
                </LimitGroup>
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
