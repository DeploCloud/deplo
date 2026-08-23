"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { gqlAction } from "@/lib/graphql-client";
import { MigrationGraphic } from "./migration-graphic";
import { MigrationReportDialog, RUN_REPORT_QUERY } from "./migration-report";
import type { ImportRun, ReportItem } from "./types";

/**
 * Every migration this team has run, and the report each one left behind.
 *
 * A table rather than cards: the rows are all the same four facts and the only
 * question anyone brings here is "which run was that, and what did it do" -
 * which is a scan down a column, not a browse. The wizard next door is where
 * you start one, so this tab never offers to.
 *
 * The report is fetched on demand. `dokployImports` deliberately returns runs
 * WITHOUT their items (a team with twenty migrations would otherwise ship
 * thousands of lines to render four dates), so opening one is a second call.
 */

export function MigrationsHistory({
  runs,
  onUseAddress,
}: {
  runs: ImportRun[];
  /** Take that address back to the wizard. The key was never stored. */
  onUseAddress: (run: ImportRun) => void;
}) {
  const [loadingId, setLoadingId] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<ReportItem[] | null>(null);

  async function openReport(run: ImportRun) {
    setLoadingId(run.id);
    const res = await gqlAction<
      { dokployImport: { items: ReportItem[] } | null },
      { items: ReportItem[] } | null
    >(RUN_REPORT_QUERY, { id: run.id }, (d) => d.dokployImport);
    setLoadingId(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    // A run that is gone is a row someone else deleted the team out from under;
    // saying so beats an empty dialog.
    if (!res.data) {
      toast.error("That migration is no longer here");
      return;
    }
    setReport(res.data.items);
  }

  if (runs.length === 0)
    return (
      <EmptyState
        graphic={<MigrationGraphic state="connect" className="h-28" />}
        title="No migrations yet"
        description="Once you bring a Dokploy over, every run and its report stay here."
      />
    );

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table className="min-w-[42rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="max-w-[16rem]">
                  <div className="truncate font-medium">
                    {r.orgName ?? r.sourceUrl}
                  </div>
                  {r.orgName && (
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {r.sourceUrl}
                    </div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {/* No seconds: nobody has two migrations in the same minute,
                      and the column is read for "which run", not for timing. */}
                  {new Date(r.startedAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  <div className="mt-1 text-xs text-muted-foreground">
                    by {r.actor}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{r.created} created</Badge>
                    {r.manual > 0 && (
                      <Badge variant="warning">{r.manual} to check</Badge>
                    )}
                    {r.failed > 0 && (
                      <Badge variant="destructive">{r.failed} failed</Badge>
                    )}
                    {r.status !== "done" && (
                      <Badge variant="outline">{r.status}</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void openReport(r)}
                      disabled={loadingId != null}
                    >
                      {loadingId === r.id && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      View report
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onUseAddress(r)}
                    >
                      Use this address
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <MigrationReportDialog
        open={report !== null}
        onOpenChange={(o) => !o && setReport(null)}
        items={report ?? []}
        description="What this migration did, line by line. Nothing here was deployed."
      />
    </>
  );
}
