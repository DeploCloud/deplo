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
import { SOURCE_COPY, SourceMark } from "./sources";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/shared/user-avatar";

/**
 * Every migration this team has run, and the report each one left behind. The
 * wizard next door is where you start one, so this tab never offers to.
 */

export function MigrationsHistory({ runs }: { runs: ImportRun[] }) {
  const [open, setOpen] = React.useState<ImportRun | null>(null);

  if (runs.length === 0)
    return (
      <EmptyState
        graphic={<MigrationGraphic state="connect" className="h-28" />}
        title="No migrations yet"
        docs="migration.dokploy"
        description="Once you bring a Dokploy or a Coolify over, every run and its log stay here."
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
                  <div className="flex items-center gap-2 font-medium">
                    <SimpleTooltip content={SOURCE_COPY[r.platform].name}>
                      <span className="inline-flex">
                        <SourceMark kind={r.platform} />
                      </span>
                    </SimpleTooltip>
                    <span className="truncate">{r.orgName ?? r.sourceUrl}</span>
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
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <UserAvatar
                      name={r.actor}
                      username={r.actorUsername}
                      avatarUrl={r.actorAvatarUrl}
                      size="xs"
                    />
                    {r.actor}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{r.created} created</Badge>
                    {r.manual > 0 && (
                      <Badge variant="warning">{r.manual} need you</Badge>
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpen(r)}
                  >
                    <ScrollText className="size-4" />
                    Show log
                  </Button>
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
