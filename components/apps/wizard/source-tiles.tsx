"use client";

import Link from "@/components/ui/link";
import { ArrowRight, LayoutTemplate } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { veilProps } from "@/components/templates/veil";
import { SOURCE_TABS, type SourceTab } from "@/components/apps/source-tabs";
import type { DeploySource } from "@/lib/types/app";
import { cn } from "@/lib/utils";

export function SourceTiles({
  value,
  onSelect,
  templatesHref,
}: {
  value: DeploySource | null;
  onSelect: (source: DeploySource) => void;
  templatesHref: string;
}) {
  const lead = SOURCE_TABS.slice(0, 2);
  const rest = SOURCE_TABS.slice(2);
  return (
    <div role="radiogroup" aria-label="Source" className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {lead.map((tab) => (
          <SourceTile
            key={tab.id}
            tab={tab}
            size="lg"
            selected={value === tab.id}
            onSelect={() => onSelect(tab.id)}
          />
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {rest.map((tab) => (
          <SourceTile
            key={tab.id}
            tab={tab}
            size="sm"
            selected={value === tab.id}
            onSelect={() => onSelect(tab.id)}
          />
        ))}
      </div>
      <TemplateTile href={templatesHref} />
    </div>
  );
}

function TemplateTile({ href }: { href: string }) {
  const veil = veilProps({ tone: "dark" }, "hover");
  return (
    <Link
      href={href}
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        veil.className,
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground ring-1 ring-border">
        <LayoutTemplate className="size-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">Template</span>
        <span className="mt-1 block text-xs leading-snug text-muted-foreground">
          Start from a ready-made stack.
        </span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
    </Link>
  );
}

export function SourceMark({
  tab,
  size = "sm",
}: {
  tab: SourceTab;
  size?: "sm" | "lg";
}) {
  const Icon = tab.icon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center ring-1 ring-border",
        size === "lg" ? "size-11 rounded-lg" : "size-9 rounded-md",
      )}
      style={{ backgroundColor: tab.brand.bg, color: tab.brand.fg }}
    >
      <Icon className={size === "lg" ? "size-5.5" : "size-4.5"} />
    </span>
  );
}

function SourceTile({
  tab,
  size,
  selected,
  onSelect,
}: {
  tab: SourceTab;
  size: "lg" | "sm";
  selected: boolean;
  onSelect: () => void;
}) {
  const lg = size === "lg";
  const veil = veilProps(tab.veil, selected ? "on" : "hover");
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={veil.style}
      className={cn(
        "flex flex-col items-start rounded-lg border text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        lg ? "gap-3 p-4" : "gap-2 p-3",
        selected
          ? "border-primary ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20",
        veil.className,
      )}
    >
      <SourceMark tab={tab} size={size} />
      <span className="w-full min-w-0">
        <span
          className={cn(
            "flex items-center gap-2 font-medium",
            lg ? "text-base" : "text-sm",
          )}
        >
          {tab.label}
          {tab.id === "git" && <Badge variant="info">Beta</Badge>}
        </span>
        <span className="mt-1 line-clamp-2 min-h-[2lh] text-xs leading-snug text-muted-foreground">
          {tab.blurb}
        </span>
      </span>
    </button>
  );
}
