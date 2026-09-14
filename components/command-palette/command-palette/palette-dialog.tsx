"use client";

import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BreadcrumbGraph } from "@/lib/breadcrumb-model";
import type { TeamIdentity } from "@/lib/types/team";
import { cn } from "@/lib/utils";
import {
  closePalette,
  togglePalette,
  openPalette,
  usePaletteGeneration,
  usePaletteOpen,
} from "../palette-open";
import { PaletteBody } from "./palette-body";

// CommandPaletteProps - what the topbar already holds and the palette reuses.
export interface CommandPaletteProps {
  userId: string;
  team: TeamIdentity;
  // Every team the caller can reach - the topbar's switcher already has them.
  teams: { id: string; name: string; avatarUrl?: string | null }[];
  // The team's apps and databases, already in the browser for the breadcrumb.
  breadcrumb: BreadcrumbGraph;
  capabilities: string[];
  isAdmin: boolean;
}

// CommandPalette - the ⌘K dialog, mounted once for the whole dashboard.
export function CommandPalette(props: CommandPaletteProps) {
  const open = usePaletteOpen();
  const generation = usePaletteGeneration();

  // ⌘K / Ctrl K works ANYWHERE, a field included - that is the point of it.
  // "/" keeps the contract it had in the sidebar: never while typing.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        togglePalette();
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true']"))
          return;
        e.preventDefault();
        openPalette();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closePalette()}>
      <DialogContent
        selfManaged
        hideClose
        overlayClassName="bg-black/60 backdrop-blur-lg"
        className={cn(
          // Beat the base centring: tailwind-merge lets the later class win.
          "top-[12vh] flex max-w-2xl translate-y-0 flex-col gap-0 overflow-hidden p-0",
          "bg-background/30 backdrop-blur-xl",
          "max-sm:inset-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-none max-sm:border-0",
        )}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search apps, pages, settings and actions
        </DialogDescription>
        {/* NOT gated on `open`: Radix unmounts these children itself, and gating
            emptied the card the instant you hit Escape. Keyed on the opening
            instead, so a re-open that beats the animation starts clean. */}
        <PaletteBody key={generation} {...props} />
      </DialogContent>
    </Dialog>
  );
}
