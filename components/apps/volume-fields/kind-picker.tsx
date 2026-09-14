"use client";

import { FileText, FolderSymlink, HardDrive, Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  VOLUME_KINDS,
  VOLUME_KIND_ORDER,
  type VolumeKind,
} from "@/lib/apps/volume-model";
import { cn } from "@/lib/utils";

// KIND_ICON is the icon each storage kind is drawn with.
export const KIND_ICON: Record<VolumeKind, LucideIcon> = {
  named: HardDrive,
  app: FileText,
  host: FolderSymlink,
};

// KindCard is one of the three answers to "where should this data live?".
export function KindCard({
  kind,
  selected,
  canMountHostVolumes,
  onSelect,
}: {
  kind: VolumeKind;
  selected: boolean;
  canMountHostVolumes: boolean;
  onSelect: () => void;
}) {
  const meta = VOLUME_KINDS[kind];
  const Icon = KIND_ICON[kind];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex h-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        selected
          ? "border-primary bg-primary-wash ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20 hover:bg-surface",
      )}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border",
          selected
            ? "border-primary/40 bg-background text-primary"
            : "border-border bg-surface-strong text-muted-foreground",
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 space-y-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{meta.label}</span>
          {kind === "named" && <Badge variant="secondary">Most apps</Badge>}
          {kind === "host" && (
            <Badge variant={canMountHostVolumes ? "muted" : "warning"}>
              {canMountHostVolumes ? "Advanced" : "Needs permission"}
            </Badge>
          )}
        </span>
        <span className="block text-xs text-muted-foreground">
          {meta.examples}
        </span>
      </span>
    </button>
  );
}

// EmptyPicker is the first add: each kind says what it is FOR, and clicking one creates an entry already set to it.
export function EmptyPicker({
  onAdd,
  canMountHostVolumes,
}: {
  onAdd: (kind: VolumeKind) => void;
  canMountHostVolumes: boolean;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border p-6">
      <div className="mb-5 flex flex-col items-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-secondary">
          <HardDrive className="size-5 text-muted-foreground" />
        </span>
        <p className="text-sm font-medium">No storage yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Everything this app writes is thrown away when it redeploys, unless
          you keep it here. Pick where the data should live:
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["named", "app"] as VolumeKind[]).map((kind) => {
          const meta = VOLUME_KINDS[kind];
          const Icon = KIND_ICON[kind];
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onAdd(kind)}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-surface"
            >
              <span className="flex items-center gap-2">
                <Icon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{meta.label}</span>
                {kind === "named" && (
                  <Badge variant="secondary" className="ml-auto">
                    Most apps
                  </Badge>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {meta.summary}
              </span>
              <span className="text-xs text-muted-foreground/70">
                {meta.examples}
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => onAdd("host")}
        className="mt-2 flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-left transition-colors hover:bg-surface"
      >
        <FolderSymlink className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">{VOLUME_KINDS.host.label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {VOLUME_KINDS.host.summary}
        </span>
        <Badge variant="muted" className="shrink-0">
          {canMountHostVolumes ? "Advanced" : "Needs permission"}
        </Badge>
      </button>
    </div>
  );
}

// AddMenu adds another entry: the same three explained options, in a menu.
export function AddMenu({
  onAdd,
  canMountHostVolumes,
}: {
  onAdd: (kind: VolumeKind) => void;
  canMountHostVolumes: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus className="size-4" />
          Add storage
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {VOLUME_KIND_ORDER.map((kind) => {
          const meta = VOLUME_KINDS[kind];
          const Icon = KIND_ICON[kind];
          return (
            <DropdownMenuItem
              key={kind}
              onSelect={() => onAdd(kind)}
              className="items-start gap-2.5"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 space-y-0.5">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {meta.label}
                  {meta.needsPermission && !canMountHostVolumes && (
                    <Badge variant="warning">Permission</Badge>
                  )}
                </span>
                <span className="block text-xs leading-relaxed whitespace-normal text-muted-foreground">
                  {meta.summary}
                </span>
                <span className="block text-xs leading-relaxed whitespace-normal text-muted-foreground/70">
                  {meta.examples}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
