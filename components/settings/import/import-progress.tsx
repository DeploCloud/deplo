"use client";

import * as React from "react";
import {
  Check,
  CircleSlash,
  DownloadCloud,
  Loader2,
  Lock,
  ScrollText,
  SkipForward,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { ReportItem } from "./types";

/**
 * The import as it happens: a dialog, not a step.
 *
 * It is not a step because nothing on it is a decision - watching is optional,
 * and a wizard that parks you in front of a progress bar is a wizard that makes
 * you wait for it. Closing it does not stop anything (the loop lives in the
 * wizard), and the pill puts it back.
 */

export interface ImportProgress {
  done: number;
  total: number;
  current: string;
}

export function ImportProgressDialog({
  open,
  onOpenChange,
  progress,
  items,
  failure,
  running,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  progress: ImportProgress;
  items: ReportItem[];
  failure: string | null;
  running: boolean;
}) {
  const pct = progress.total === 0 ? 0 : (progress.done / progress.total) * 100;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {failure
              ? "Import stopped"
              : running
                ? progress.current || "Finishing"
                : "Import finished"}
          </DialogTitle>
          <DialogDescription>
            {failure
              ? failure
              : running
                ? `Project ${Math.min(progress.done + 1, progress.total)} of ${progress.total}. You can close this - the import keeps going.`
                : `${progress.total} project(s) read.`}
          </DialogDescription>
        </DialogHeader>

        <Progress value={pct} />

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {items.map((i, n) => (
            <ItemLine key={n} item={i} />
          ))}
        </div>

        {failure && (
          <p className="text-sm text-muted-foreground">
            Everything created so far is kept. Running the import again resumes from
            here - whatever is already in Deplo is skipped.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The way back into the dialog, anchored to the viewport so it survives every
 * step. Only rendered while there is a run to look at.
 *
 * Bottom CENTRE, not the corner: sonner puts its toasts bottom-right and this
 * flow raises one on every failed call, so a pill parked there spends the whole
 * import underneath them. Centre is also where the repo already puts a
 * persistent status strip (`server-connection-guard`), which owns the top of
 * that stack when a host actually drops.
 */
export function ImportProgressPill({
  progress,
  running,
  failure,
  onOpen,
}: {
  progress: ImportProgress;
  running: boolean;
  failure: string | null;
  onOpen: () => void;
}) {
  return (
    <Button
      variant={failure ? "destructive" : "secondary"}
      onClick={onOpen}
      className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 shadow-lg"
    >
      {failure ? (
        <TriangleAlert className="size-4" />
      ) : running ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <ScrollText className="size-4" />
      )}
      {failure
        ? "Import stopped"
        : running
          ? `Importing ${progress.done}/${progress.total}`
          : "Import log"}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* One report line                                                    */
/* ------------------------------------------------------------------ */

const OUTCOME_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  created: Check,
  skipped: SkipForward,
  failed: TriangleAlert,
  manual: DownloadCloud,
  unsupported: CircleSlash,
};

export function ItemLine({ item }: { item: ReportItem }) {
  const Icon = OUTCOME_ICON[item.outcome] ?? Lock;
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          item.outcome === "created"
            ? "text-primary"
            : item.outcome === "failed"
              ? "text-destructive"
              : item.outcome === "manual" || item.outcome === "unsupported"
                ? "text-warning"
                : "text-muted-foreground",
        )}
      />
      <div className="min-w-0">
        <span className="text-muted-foreground">{item.path}</span>
        {item.message && <span className="ml-2">{item.message}</span>}
      </div>
    </div>
  );
}
