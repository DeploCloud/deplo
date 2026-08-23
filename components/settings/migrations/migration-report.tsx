"use client";

import * as React from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ItemLine } from "./migration-progress";
import type { ReportItem } from "./types";

/**
 * The report a migration leaves behind, grouped by outcome.
 *
 * A dialog rather than a page, and the same dialog from both homes: the wizard
 * that just finished, and the History tab the morning after. Reading what
 * happened is not a place you navigate to - it is a thing you glance at and
 * close - and one renderer means the two can never drift.
 */

/**
 * One run's report lines. Lives next to the dialog that renders them, because
 * both homes that fetch it - the History tab and the wizard watching somebody
 * else's migration - render it through that dialog.
 */
export const RUN_REPORT_QUERY = /* GraphQL */ `
  query MigrationRunReport($id: String!) {
    dokployImport(id: $id) {
      id
      items {
        path
        sourceKind
        sourceName
        outcome
        targetKind
        targetId
        message
      }
    }
  }
`;

const OUTCOME_ORDER = ["failed", "manual", "unsupported", "created", "skipped"];

const OUTCOME_TITLE: Record<string, string> = {
  failed: "Could not be imported",
  manual: "Imported, needs a look",
  unsupported: "No equivalent in Deplo",
  created: "Created",
  skipped: "Skipped",
};

export function MigrationReportDialog({
  open,
  onOpenChange,
  items,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ReportItem[];
  description: string;
}) {
  const groups = OUTCOME_ORDER.map((outcome) => ({
    outcome,
    rows: items.filter((i) => i.outcome === outcome),
  })).filter((g) => g.rows.length > 0);

  function copyReport() {
    const md = groups
      .map(
        (g) =>
          `## ${OUTCOME_TITLE[g.outcome] ?? g.outcome}\n\n` +
          g.rows
            .map(
              (r) =>
                `- **${r.path}** (${r.sourceKind})` +
                (r.message ? ` - ${r.message}` : ""),
            )
            .join("\n"),
      )
      .join("\n\n");
    navigator.clipboard.writeText(md);
    toast.success("Report copied");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wider than the house default: every line is a path plus a sentence, and
          at `max-w-lg` the useful half wraps. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader className="pr-10">
          <DialogTitle>Report</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Bounded so a 300-line migration scrolls inside the dialog instead of
            pushing its footer off the screen. */}
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.outcome}>
              <div className="text-sm font-medium">
                {OUTCOME_TITLE[g.outcome] ?? g.outcome}
                <span className="ml-2 text-muted-foreground">
                  {g.rows.length}
                </span>
              </div>
              <div className="mt-1 space-y-1">
                {g.rows.map((r, i) => (
                  <ItemLine key={i} item={r} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={copyReport}>
            <Copy className="size-4" />
            Copy
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
