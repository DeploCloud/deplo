"use client";

import Link from "@/components/ui/link";
import {
  ArrowUpRight,
  ChevronDown,
  Pencil,
  Plus,
  Share2,
  Trash2,
} from "lucide-react";
import { AppLogo } from "@/components/shared/project-logo";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RowActions } from "@/components/shared/row-actions";
import { ROW_ACTIONS_CELL } from "@/components/shared/row-actions-cell";
import {
  EnvSelectionCell,
  EnvSelectionHead,
} from "@/components/env/env-bulk-selection";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { TimeAgo } from "@/components/shared/time-ago";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import { EnvEditButton } from "@/components/env/env-edit-button";
import { cn } from "@/lib/utils";
import type { AppBucket } from "@/lib/env-grouping";
import type { EnvVarDTO } from "@/lib/types/env";
import type { AppEnvGroup } from "@/lib/data/env";
import type { AppliedSharedVarDTO } from "@/lib/data/shared-vars/app-view";

export type RowApp = AppEnvGroup["app"];

type SharedVar = AppliedSharedVarDTO & { type: "plain" | "secret" };

export type EnvRow =
  | ({ kind: "standalone"; app: RowApp; projectName: string } & EnvVarDTO)
  | ({ kind: "shared"; app: RowApp; projectName: string } & SharedVar);

export const rowKey = (row: EnvRow) =>
  row.kind === "standalone"
    ? `standalone:${row.id}`
    : `shared:${row.app.id}:${row.id}`;

function appSubtitle(
  app: RowApp,
  environmentName: Map<string, string>,
): string {
  return [
    app.environmentId ? environmentName.get(app.environmentId) : null,
    app.primaryDomain,
  ]
    .filter(Boolean)
    .join(" · ");
}

export const plural = (n: number, one: string) =>
  `${n} ${one}${n === 1 ? "" : "s"}`;

export function AppVarsCard({
  card,
  open,
  onToggle,
  environmentName,
  onAdd,
  onEdit,
  onDelete,
  onEditShared,
  editableSharedIds,
}: {
  card: AppBucket<EnvRow>;
  open: boolean;
  onToggle: () => void;
  environmentName: Map<string, string>;
  onAdd: () => void;
  onEdit: (row: EnvVarDTO) => void;
  onDelete: (id: string) => void;
  onEditShared: (id: string) => void;
  editableSharedIds: Set<string>;
}) {
  const { app, rows } = card;
  const subtitle = appSubtitle(app, environmentName);
  const bodyId = `vars-app-${app.id}`;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              !open && "-rotate-90",
            )}
          />
          <AppLogo logo={app.logo} size={32} />
          <span className="min-w-0">
            <span className="block truncate text-base leading-none font-semibold tracking-tight lg:text-lg">
              {app.name}
            </span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">
              {[subtitle, open ? null : plural(rows.length, "variable")]
                .filter(Boolean)
                .join(" · ") || plural(rows.length, "variable")}
            </span>
          </span>
        </button>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="size-4" />
            Add
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/apps/${app.slug}/environment`}>
              Open
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent id={bodyId}>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table className="max-md:[&_td]:px-2 max-md:[&_td>div]:flex-wrap max-md:[&_th]:px-2">
              <TableHeader>
                <TableRow>
                  <EnvSelectionHead ids={rows.map(rowKey)} />
                  <TableHead className="whitespace-nowrap">Key</TableHead>
                  <TableHead className="w-full max-md:w-auto">Value</TableHead>
                  <TableHead className="whitespace-nowrap max-md:hidden">
                    Last modified
                  </TableHead>
                  <TableHead className="whitespace-nowrap max-md:hidden">
                    Modified by
                  </TableHead>
                  <TableHead className="text-right whitespace-nowrap">
                    <span className="max-md:sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) =>
                  row.kind === "standalone" ? (
                    <TableRow key={`${app.id}:standalone:${row.id}`}>
                      <EnvSelectionCell id={rowKey(row)} />
                      <TableCell className="font-mono text-xs font-medium">
                        {row.key}
                      </TableCell>
                      <TableCell>
                        <EnvValueCell value={row.value} masked={row.masked} />
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground max-md:hidden">
                        <TimeAgo at={row.updatedAt} />
                      </TableCell>
                      <TableCell className="max-md:hidden">
                        <EnvAuthorCell
                          author={row.updatedBy ?? row.createdBy ?? null}
                        />
                      </TableCell>
                      <TableCell className={`text-right ${ROW_ACTIONS_CELL}`}>
                        <RowActions
                          title={row.key}
                          actions={[
                            {
                              label: "Edit",
                              icon: Pencil,
                              disabled: row.type === "secret",
                              onSelect: () => onEdit(row),
                            },
                            {
                              label: "Delete",
                              icon: Trash2,
                              destructive: true,
                              onSelect: () => onDelete(row.id),
                            },
                          ]}
                        >
                          <div className="flex justify-end gap-1">
                            <EnvEditButton
                              secret={row.type === "secret"}
                              onClick={() => onEdit(row)}
                            />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => onDelete(row.id)}
                              aria-label="Delete"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </RowActions>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={`${app.id}:shared:${row.id}`}>
                      <EnvSelectionCell id={rowKey(row)} />
                      <TableCell className="font-mono text-xs font-medium">
                        <div className="flex items-center gap-2">
                          {row.key}
                          <Badge
                            variant="muted"
                            className="gap-1 text-[10px] font-normal whitespace-nowrap"
                          >
                            <Share2 className="size-3" />
                            Shared
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <EnvValueCell value={row.value} masked={row.masked} />
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground max-md:hidden">
                        <TimeAgo at={row.updatedAt} />
                      </TableCell>
                      <TableCell className="max-md:hidden">
                        <EnvAuthorCell author={row.updatedBy ?? null} />
                      </TableCell>
                      <TableCell className={`text-right ${ROW_ACTIONS_CELL}`}>
                        <div className="flex justify-end gap-1">
                          {editableSharedIds.has(row.id) ? (
                            <EnvEditButton
                              secret={row.type === "secret"}
                              label="Edit shared variable"
                              onClick={() => onEditShared(row.id)}
                            />
                          ) : (
                            <SimpleTooltip content="Another team owns this variable. Only they can change it.">
                              <span className="text-xs text-muted-foreground">
                                Read-only
                              </span>
                            </SimpleTooltip>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
