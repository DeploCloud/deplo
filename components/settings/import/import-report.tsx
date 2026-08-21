"use client";

import * as React from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ItemLine } from "./import-progress";
import type { ReportItem } from "./types";

/**
 * The report an import leaves behind, grouped by outcome.
 *
 * Lives on its own because it has two homes: the last step of the wizard, and
 * the page you open the morning after. The wizard used to be the only one, which
 * meant the whole list of "this one needs a person" lines died with the tab that
 * ran the import.
 */

const OUTCOME_ORDER = ["failed", "manual", "unsupported", "created", "skipped"];

const OUTCOME_TITLE: Record<string, string> = {
  failed: "Could not be imported",
  manual: "Imported, needs a look",
  unsupported: "No equivalent in Deplo",
  created: "Created",
  skipped: "Skipped",
};

export function ImportReport({
  items,
  description,
}: {
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
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Report</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={copyReport}>
          <Copy className="size-4" />
          Copy
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.map((g) => (
          <div key={g.outcome}>
            <div className="text-sm font-medium">
              {OUTCOME_TITLE[g.outcome] ?? g.outcome}
              <span className="ml-2 text-muted-foreground">{g.rows.length}</span>
            </div>
            <div className="mt-1 space-y-1">
              {g.rows.map((r, i) => (
                <ItemLine key={i} item={r} />
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
