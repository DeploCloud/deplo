"use client";

import * as React from "react";
import { ScrollText } from "lucide-react";

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
import { MigrationGraphic } from "./migration-graphic";
import { MigrationConsole } from "./migration-console";
import type { ImportRun } from "./types";

/**
 * Every migration this team has run, and the report each one left behind. The
 * wizard next door is where you start one, so this tab never offers to.
 */

export function MigrationsHistory({
  runs,
  onUseAddress,
}: {
  runs: ImportRun[];
  /** Take that address back to the wizard. The key was never stored. */
  onUseAddress: (run: ImportRun) => void;
}) {
  const [open, setOpen] = React.useState<ImportRun | null>(null);

  if (runs.length === 0)
    return (
      <EmptyState
        graphic={<MigrationGraphic state="connect" className="h-28" />}
        title="No migrations yet"
        docs="migration.dokploy"
        description="Once you bring a Dokploy over, every run and its log stay here."
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
                <TableCell className="text-sm whitespace-nowrap">
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
                      onClick={() => setOpen(r)}
                    >
                      <ScrollText className="size-4" />
                      Show log
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

      <MigrationConsole
        runId={open?.id ?? null}
        open={open !== null}
        onOpenChange={(o) => !o && setOpen(null)}
        // A run still moving is watchable from here too - History is just
        // another door onto the same console.
        live={open?.status === "running"}
      />
    </>
  );
}
