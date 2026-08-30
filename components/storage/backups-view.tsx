"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, Ban, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useCardSelection } from "@/components/shared/use-card-selection";
import {
  SelectableCard,
  SelectionBar,
  SelectionCanvas,
  useSelectionShortcuts,
} from "@/components/shared/card-selection";
import { ListToolbar, type ListView } from "@/components/shared/list-toolbar";
import { OptimisticList } from "@/components/shared/optimistic-list";
import { BackupRow } from "@/components/storage/backup-row";
import { BackupCard } from "@/components/storage/backup-card";
import { gqlAction } from "@/lib/graphql-client";
import type { BackupDTO } from "@/lib/data/backups";
import type { DestinationOption } from "@/lib/data/destinations";

/** shadcn `SelectItem` can't hold "", so "any" needs a sentinel of its own. */
const ALL = "__all__";

const STATUS_LABELS: Record<string, string> = {
  success: "Succeeded",
  failed: "Failed",
  running: "Running",
  never: "Never run",
};

/**
 * The Backups tab: search, target / outcome / destination filters, and a table
 * or a grid of cards.
 */
export function BackupsView({
  backups,
  destinations,
  canManage,
  canRestore,
  canTestDestinations,
  createButton,
}: {
  backups: BackupDTO[];
  destinations: DestinationOption[];
  canManage: boolean;
  canRestore: boolean;
  canTestDestinations: boolean;
  createButton: React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const [target, setTarget] = React.useState<"all" | "app" | "database">("all");
  const [status, setStatus] = React.useState<string>("all");
  const [destination, setDestination] = React.useState<string>(ALL);
  const [view, setView] = React.useState<ListView>("grid");
  const router = useRouter();

  const q = query.trim().toLowerCase();
  const filtered = backups.filter((b) => {
    if (target !== "all" && b.targetKind !== target) return false;
    if (status !== "all" && b.lastStatus !== status) return false;
    if (destination !== ALL && b.destinationId !== destination) return false;
    if (!q) return true;
    return [b.name, b.serviceName, b.databaseName, b.destinationName].some(
      (v) => v?.toLowerCase().includes(q),
    );
  });

  const rowProps = { destinations, canManage, canRestore, canTestDestinations };

  /* ---- Multi-selection (marquee + ctrl/shift-click) + bulk actions ------- */
  // Only what is ON SCREEN is selectable, in display order, so a shift-click
  // range spans the list exactly as it reads.
  const visibleIds = filtered.map((b) => b.id);
  const selection = useCardSelection(visibleIds);
  const {
    selected,
    marqueeRef,
    canvasRef,
    onCanvasPointerDown,
    onItemClick,
    clear: clearSelection,
    selectAll,
  } = selection;
  const selectedIds = visibleIds.filter((id) => selected.has(id));
  const selectionCount = selectedIds.length;
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  useSelectionShortcuts({
    count: selectionCount,
    selectAll,
    clear: clearSelection,
    onDelete: canManage ? () => setBulkDeleteOpen(true) : undefined,
  });

  const selectionNoun = `${selectionCount} schedule${selectionCount === 1 ? "" : "s"}`;

  // One mutation per selected schedule - there is no bulk endpoint. The first
  // refusal is surfaced verbatim and the selection SURVIVES it, so re-confirming
  // retries.
  async function bulkRun(
    mutation: string,
    vars: (id: string) => Record<string, unknown>,
    success: string,
  ) {
    const results = await Promise.all(
      selectedIds.map((id) => gqlAction(mutation, vars(id))),
    );
    router.refresh();
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) toast.error(failed.error);
    else {
      toast.success(success);
      clearSelection();
    }
    return failed ?? { ok: true as const, data: undefined };
  }

  return (
    <div className="space-y-4">
      <ListToolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search backups"
        view={view}
        onView={setView}
        listLabel="Table view"
        action={createButton}
        filters={
          <>
            <Select
              value={target}
              onValueChange={(v) => setTarget(v as typeof target)}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="Target" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All targets</SelectItem>
                <SelectItem value="app">Apps</SelectItem>
                <SelectItem value="database">Databases</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="Last run" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any last run</SelectItem>
                {Object.entries(STATUS_LABELS).map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={destination} onValueChange={setDestination}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue placeholder="Destination" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All destinations</SelectItem>
                {destinations.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

      <SelectionCanvas
        canvasRef={canvasRef}
        marqueeRef={marqueeRef}
        onPointerDown={onCanvasPointerDown}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No matching backups"
            description="No backup schedule matches the current search and filters."
          />
        ) : view === "grid" ? (
          <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <OptimisticList>
              {filtered.map((b) => (
                <SelectableCard
                  key={b.id}
                  id={b.id}
                  selected={selected.has(b.id)}
                  onSelect={(e) => onItemClick(b.id, e)}
                >
                  <BackupCard backup={b} {...rowProps} />
                </SelectableCard>
              ))}
            </OptimisticList>
          </div>
        ) : (
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Retention</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <OptimisticList>
                  {filtered.map((b) => (
                    <BackupRow
                      key={b.id}
                      backup={b}
                      {...rowProps}
                      selected={selected.has(b.id)}
                      onSelect={onItemClick}
                    />
                  ))}
                </OptimisticList>
              </TableBody>
            </Table>
          </div>
        )}
      </SelectionCanvas>

      <SelectionBar
        count={selectionCount}
        onSelectAll={selectAll}
        onClear={clearSelection}
      >
        {canManage && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void bulkRun(
                  TOGGLE_BACKUP,
                  (id) => ({ id, enabled: true }),
                  `${selectionNoun} enabled`,
                )
              }
            >
              <Play className="size-4" />
              Enable
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void bulkRun(
                  TOGGLE_BACKUP,
                  (id) => ({ id, enabled: false }),
                  `${selectionNoun} disabled`,
                )
              }
            >
              <Ban className="size-4" />
              Disable
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </>
        )}
      </SelectionBar>

      <ConfirmAction
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${selectionNoun}?`}
        description={`${selectionCount === 1 ? "It stops" : "They stop"} running. Backups already made are not deleted.`}
        confirmLabel={`Delete ${selectionCount === 1 ? "schedule" : "schedules"}`}
        onConfirm={() =>
          bulkRun(
            `mutation($id: String!) { deleteBackup(id: $id) }`,
            (id) => ({ id }),
            `${selectionNoun} deleted`,
          )
        }
      />
    </div>
  );
}

const TOGGLE_BACKUP = `mutation($id: String!, $enabled: Boolean!) {
  toggleBackup(id: $id, enabled: $enabled)
}`;
