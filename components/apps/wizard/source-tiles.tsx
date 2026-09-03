"use client";

import Link from "@/components/ui/link";
import { ArrowRight, LayoutTemplate } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { veilProps } from "@/components/templates/veil";
import { SOURCE_TABS, type SourceTab } from "@/components/apps/source-tabs";
import type { DeploySource } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The bento of deploy sources - the wizard's first and only unavoidable choice.
 * The two git ones lead, because deploying a repository is what most people came
 * for; the other three sit under them at the size of an alternative.
 */
export function SourceTiles({
  value,
  onSelect,
  templatesHref,
}: {
  value: DeploySource | null;
  onSelect: (source: DeploySource) => void;
  /** The catalogue, carrying this wizard's placement. */
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
      {/* Three across only once there is room for three: on a phone the whole
          grid is one column and these read as the same list. */}
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

/**
 * The sixth way in, and the only one that is not a source: a template becomes a
 * compose App, so it leaves for the catalogue instead of selecting one here - a link
 * outside the radio group, in the platform's own ink rather than a brand's.
 */
function TemplateTile({ href }: { href: string }) {
  // The neutral wash, not a hue: the mark is a single ink, which is the case
  // that veil was written for. Lit on hover and on keyboard focus, like the
  // template cards this leads to.
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

/** A source's own mark on its own colour - the tile's, and the header's on the
 *  step that follows, so the choice you made is still on screen. */
export function SourceMark({
  tab,
  size = "sm",
}: {
  tab: SourceTab;
  /** `lg` on the two lead tiles, `sm` on the rest and above a step's title. */
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
        "flex flex-col items-start rounded-lg border text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        lg ? "gap-3 p-4" : "gap-2 p-3",
        // The ring still carries "chosen": the wash says which source, not which
        // state, and both would be saying it at once otherwise.
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
        {/* Two lines, reserved AND capped, so every tile in a row is the same
            height whatever its blurb runs to. */}
        <span className="mt-1 line-clamp-2 min-h-[2lh] text-xs leading-snug text-muted-foreground">
          {tab.blurb}
        </span>
      </span>
    </button>
  );
}
