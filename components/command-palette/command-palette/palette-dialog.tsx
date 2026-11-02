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

export interface CommandPaletteProps {
  userId: string;
  team: TeamIdentity;
  teams: { id: string; name: string; avatarUrl?: string | null }[];
  breadcrumb: BreadcrumbGraph;
  capabilities: string[];
  isAdmin: boolean;
}

export function CommandPalette(props: CommandPaletteProps) {
  const open = usePaletteOpen();
  const generation = usePaletteGeneration();

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
          "top-[12vh] flex max-w-2xl translate-y-0 flex-col gap-0 overflow-hidden p-0",
          "bg-background/30 backdrop-blur-xl",
          "max-md:h-[calc(100dvh-var(--sheet-top-gap))] max-md:px-0 max-md:pb-[env(safe-area-inset-bottom)]",
        )}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search apps, pages, settings and actions
        </DialogDescription>
        <PaletteBody key={generation} {...props} />
      </DialogContent>
    </Dialog>
  );
}
