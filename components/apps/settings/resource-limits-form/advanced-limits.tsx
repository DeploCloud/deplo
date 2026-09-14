"use client";

import * as React from "react";
import { Cpu, Gauge, HardDrive, Layers, MemoryStick } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { type ResourceLimitsForm as FormState } from "@/lib/apps/resource-limits-model";
import { LimitGroup, LimitInput, LimitRow } from "./limit-fields";

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

function AdvancedRow({
  id,
  label,
  info,
  unit,
  min,
  type,
  placeholder,
  value,
  onChange,
  note,
}: {
  id: string;
  label: string;
  info: React.ReactNode;
  unit?: string;
  min?: number;
  type?: "number" | "text";
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  note?: React.ReactNode;
}) {
  return (
    <LimitRow
      id={id}
      label={label}
      info={info}
      docs="resources.advanced"
      note={note}
    >
      <LimitInput
        id={id}
        unit={unit}
        min={min}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
      />
    </LimitRow>
  );
}

// AdvancedLimits is the collapsed section: the knobs past Memory and CPU.
export function AdvancedLimits({
  form,
  set,
  canProtectFromOom,
}: {
  form: FormState;
  set: (k: keyof FormState) => (v: string) => void;
  canProtectFromOom: boolean;
}) {
  const hasAdvanced = ADVANCED_KEYS.some((k) => form[k] !== "");
  const oomNegative = Number(form.oomScoreAdj) < 0;

  return (
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
              <AdvancedRow
                id="limit-mem-reservation"
                label="Memory reservation"
                info="Soft RAM floor the scheduler tries to keep available for this app under contention. Must be ≤ the memory limit."
                unit="MB"
                min={6}
                placeholder="e.g. 256"
                value={form.memoryReservationMb}
                onChange={set("memoryReservationMb")}
              />
              <AdvancedRow
                id="limit-swap"
                label="Swap limit"
                info="Total memory + swap ceiling. Needs a memory limit set, and must be ≥ it (the difference is how much swap the app may use)."
                unit="MB"
                min={6}
                placeholder="e.g. 1024"
                value={form.swapMb}
                onChange={set("swapMb")}
              />
            </LimitGroup>

            <LimitGroup icon={Cpu} title="CPU">
              <AdvancedRow
                id="limit-cpu-shares"
                label="CPU shares"
                info="Relative CPU weight when the host is busy (default 1024) - 2048 gets twice the share of 1024. Doesn't cap idle-time usage."
                unit="weight"
                min={2}
                placeholder="1024"
                value={form.cpuShares}
                onChange={set("cpuShares")}
              />
              <AdvancedRow
                id="limit-cpuset"
                label="CPU pinning"
                info='Pin the app to specific host cores, e.g. "0", "0,1" or "0-3". Leave empty to run on any core.'
                type="text"
                placeholder="e.g. 0,2-3"
                value={form.cpuset}
                onChange={set("cpuset")}
              />
            </LimitGroup>

            <LimitGroup icon={Layers} title="Processes & files">
              <AdvancedRow
                id="limit-pids"
                label="Process limit"
                info="Maximum number of processes/threads the container may spawn - a guard against fork bombs and runaway workers."
                unit="count"
                min={1}
                placeholder="e.g. 512"
                value={form.pidsLimit}
                onChange={set("pidsLimit")}
              />
              <AdvancedRow
                id="limit-nofile"
                label="Open files"
                info="Maximum open file descriptors (ulimit nofile). Raise it for high-connection servers hitting 'too many open files'."
                unit="count"
                min={1}
                placeholder="e.g. 1024"
                value={form.nofile}
                onChange={set("nofile")}
              />
              <AdvancedRow
                id="limit-nproc"
                label="User processes"
                info="Per-user process ceiling (ulimit nproc). Usually redundant with the process limit above."
                unit="count"
                min={1}
                placeholder="e.g. 512"
                value={form.nproc}
                onChange={set("nproc")}
              />
            </LimitGroup>

            <LimitGroup icon={HardDrive} title="Storage">
              <AdvancedRow
                id="limit-shm"
                label="Shared memory"
                info="Size of /dev/shm (shared-memory segment). Default is 64 MB; raise it for apps that need more (some databases, Chromium/Puppeteer)."
                unit="MB"
                min={1}
                placeholder="e.g. 64"
                value={form.shmSizeMb}
                onChange={set("shmSizeMb")}
              />
              <AdvancedRow
                id="limit-storage"
                label="Disk quota"
                info="Caps the writable layer, not Volume storage. Needs host support (XFS + pquota or devicemapper) or the deploy is rejected."
                unit="GB"
                min={1}
                placeholder="e.g. 10"
                value={form.storageGb}
                onChange={set("storageGb")}
              />
            </LimitGroup>

            <LimitGroup icon={Gauge} title="Under memory pressure">
              <AdvancedRow
                id="limit-oom"
                label="OOM priority"
                info={
                  canProtectFromOom
                    ? "Range -1000 to 1000. If the host runs out of memory, higher scores are killed first - negative protects this app."
                    : "Range -1000 to 1000. Higher scores are killed first when the host runs out of memory. Negative needs the host-volumes grant."
                }
                note={
                  oomNegative &&
                  !canProtectFromOom && (
                    <p className="mt-1.5 text-xs text-destructive">
                      Negative values need the host-volumes grant.
                    </p>
                  )
                }
                unit="score"
                min={canProtectFromOom ? -1000 : 0}
                placeholder="0"
                value={form.oomScoreAdj}
                onChange={set("oomScoreAdj")}
              />
            </LimitGroup>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
