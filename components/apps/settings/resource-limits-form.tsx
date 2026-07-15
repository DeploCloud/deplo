"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Save, RotateCcw, Cpu, MemoryStick, HardDrive, Layers } from "lucide-react";
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

/** A labelled numeric/text field with an optional unit suffix and info tooltip. */
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
  className,
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
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <FieldLabel info={info}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          type={type}
          inputMode={type === "number" ? "decimal" : undefined}
          min={min}
          step={step}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="max-w-[9rem]"
        />
        {unit && (
          <span className="shrink-0 text-xs text-muted-foreground">{unit}</span>
        )}
      </div>
    </div>
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
            Memory &amp; CPU
          </CardTitle>
          <CardDescription>
            Cap how much of the host this app can use. Leave a field empty to
            leave that resource uncapped. Applied on the next deploy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Quick-pick sizes fill Memory + CPU together. */}
          <div className="flex flex-wrap items-center gap-2">
            {RESOURCE_PRESETS.map((p) => (
              <Button
                key={p.label}
                type="button"
                size="sm"
                variant={activePreset?.label === p.label ? "default" : "outline"}
                onClick={() => applyPreset(p)}
              >
                {p.label}
                <span className="ml-1.5 text-xs opacity-70">
                  {p.cpuCores} CPU · {p.memoryMb >= 1024 ? `${p.memoryMb / 1024} GB` : `${p.memoryMb} MB`}
                </span>
              </Button>
            ))}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
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
        </CardContent>
        <CardFooter className="justify-between border-t border-border pt-4">
          <DirtyHint dirty={dirty} />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setForm({ ...EMPTY_RESOURCE_FORM })}
              disabled={
                pending ||
                serializeResourceForm(form) ===
                  serializeResourceForm(EMPTY_RESOURCE_FORM)
              }
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

      <Card>
        <CardContent className="pt-6">
          <Accordion type="single" collapsible>
            <AccordionItem value="advanced" className="border-none">
              <AccordionTrigger className="py-0 text-sm hover:no-underline">
                Advanced limits
              </AccordionTrigger>
              <AccordionContent className="pt-6">
                <div className="space-y-8">
                  {/* Memory */}
                  <fieldset className="space-y-4">
                    <legend className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <MemoryStick className="size-3.5" />
                      Memory
                    </legend>
                    <div className="grid gap-5 sm:grid-cols-2">
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
                    </div>
                  </fieldset>

                  {/* CPU */}
                  <fieldset className="space-y-4">
                    <legend className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <Cpu className="size-3.5" />
                      CPU
                    </legend>
                    <div className="grid gap-5 sm:grid-cols-2">
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
                    </div>
                  </fieldset>

                  {/* Processes & files */}
                  <fieldset className="space-y-4">
                    <legend className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <Layers className="size-3.5" />
                      Processes &amp; files
                    </legend>
                    <div className="grid gap-5 sm:grid-cols-2">
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
                    </div>
                  </fieldset>

                  {/* Storage */}
                  <fieldset className="space-y-4">
                    <legend className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <HardDrive className="size-3.5" />
                      Storage
                    </legend>
                    <div className="grid gap-5 sm:grid-cols-2">
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
                    </div>
                  </fieldset>

                  {/* Scheduling */}
                  <fieldset className="space-y-4">
                    <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Under memory pressure
                    </legend>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <LimitField
                        label="OOM priority"
                        unit="-1000…1000"
                        min={-1000}
                        placeholder="0"
                        value={form.oomScoreAdj}
                        onChange={set("oomScoreAdj")}
                        info="When the whole host runs out of memory, containers with a higher score are killed first. Use a negative value to protect this app, positive to sacrifice it first."
                      />
                    </div>
                  </fieldset>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>

      <UnsavedChangesGuard when={dirty} />
    </>
  );
}
