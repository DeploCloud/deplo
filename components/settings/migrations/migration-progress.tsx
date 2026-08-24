"use client";

import * as React from "react";
import {
  Check,
  CircleSlash,
  DownloadCloud,
  Lock,
  SkipForward,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";
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
 * The line-by-line log of a migration in flight.
 *
 * Secondary on purpose. The wizard's own step already says which project it is
 * on and how far along it is, which is everything a person needs to decide
 * nothing; this is the detail for whoever wants to watch a specific service go
 * over. Closing it stops nothing - the loop lives in the wizard.
 */

export interface MigrationProgress {
  done: number;
  total: number;
  current: string;
}

export function MigrationLogDialog({
  open,
  onOpenChange,
  progress,
  items,
  failure,
  running,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  progress: MigrationProgress;
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
              ? "Migration stopped"
              : running
                ? progress.current || "Finishing"
                : "Migration finished"}
          </DialogTitle>
          <DialogDescription>
            {failure
              ? failure
              : running
                ? `Project ${Math.min(progress.done + 1, progress.total)} of ${progress.total}. You can close this - the migration keeps going.`
                : `${progress.total} project(s) read.`}
          </DialogDescription>
        </DialogHeader>

        <Progress
          value={pct}
          className={running ? "deplo-progress-working" : undefined}
        />

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {items.map((i, n) => (
            <ItemLine key={n} item={i} />
          ))}
        </div>

        {failure && (
          <p className="text-sm text-muted-foreground">
            Everything created so far is kept. Running the migration again
            resumes from here - whatever is already in Deplo is skipped.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* One report line                                                    */
/* ------------------------------------------------------------------ */

const OUTCOME_ICON: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
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
