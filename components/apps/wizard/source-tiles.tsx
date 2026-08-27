"use client";

import { Badge } from "@/components/ui/badge";
import { veilProps } from "@/components/templates/veil";
import { SOURCE_TABS, type SourceTab } from "@/components/apps/source-tabs";
import type { DeploySource } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The bento of deploy sources - the wizard's first and only unavoidable choice. */
export function SourceTiles({
  value,
  onSelect,
}: {
  value: DeploySource | null;
  onSelect: (source: DeploySource) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Source"
      className="grid gap-2 sm:grid-cols-2"
    >
      {SOURCE_TABS.map((tab, i) => (
        <SourceTile
          key={tab.id}
          tab={tab}
          selected={value === tab.id}
          onSelect={() => onSelect(tab.id)}
          // An odd count leaves the last tile alone on its row; widening it is
          // what makes the grid read as finished rather than one short.
          wide={i === SOURCE_TABS.length - 1 && SOURCE_TABS.length % 2 === 1}
        />
      ))}
    </div>
  );
}

/** A source's own mark on its own colour - the tile's, and the header's on the
 *  step that follows, so the choice you made is still on screen. */
export function SourceMark({
  tab,
  className,
}: {
  tab: SourceTab;
  className?: string;
}) {
  const Icon = tab.icon;
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md ring-1 ring-border",
        className,
      )}
      style={{ backgroundColor: tab.brand.bg, color: tab.brand.fg }}
    >
      <Icon className="size-4.5" />
    </span>
  );
}

function SourceTile({
  tab,
  selected,
  onSelect,
  wide,
}: {
  tab: SourceTab;
  selected: boolean;
  onSelect: () => void;
  wide: boolean;
}) {
  // The same wash the template store and the MCP wizard wear: lit on hover while
  // you are still looking, held lit once this is the one you chose.
  const veil = veilProps(tab.veil, selected ? "on" : "hover");
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={veil.style}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4 text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        // The ring still carries "chosen": the wash says which source, not which
        // state, and both would be saying it at once otherwise.
        selected
          ? "border-primary ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20",
        wide && "sm:col-span-2",
        veil.className,
      )}
    >
      <SourceMark tab={tab} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {tab.label}
          {tab.id === "git" && <Badge variant="info">Beta</Badge>}
        </span>
        {/* Two lines, reserved AND capped, so every tile is the same height
            whatever its blurb runs to. */}
        <span className="mt-1 line-clamp-2 min-h-[2lh] text-xs leading-snug text-muted-foreground">
          {tab.blurb}
        </span>
      </span>
    </button>
  );
}
