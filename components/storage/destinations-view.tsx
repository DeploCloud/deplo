"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { HardDrive, PlugZap, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  PendingCards,
  usePendingCreate,
} from "@/components/shared/pending-create";
import { DestinationCard } from "@/components/storage/destination-card";
import { DestinationsTable } from "@/components/storage/destinations-table";
import type { DestinationCardView } from "@/components/storage/destination-actions";
import { probeDestinations } from "@/lib/destination-probe";
import { gqlAction } from "@/lib/graphql-client";
import type { DestinationStatus } from "@/lib/types";

/** What a fresh probe overwrites on a destination we already rendered. */
type Live = Pick<
  DestinationCardView,
  "status" | "lastTestError" | "lastTestAt" | "freeBytes" | "totalBytes"
>;

const STATUS_LABELS: Record<DestinationStatus, string> = {
  connected: "Connected",
  error: "Error",
  unverified: "Unverified",
};

/**
 * The Destinations tab: search, kind + status filters, card or table, and the
 * create button at the end of the same row.
 */
export function DestinationsView({
  destinations,
  canManage,
  createButton,
}: {
  destinations: DestinationCardView[];
  /** `manage_backup_destinations`. Also gates the probe below. */
  canManage: boolean;
  createButton: React.ReactNode;
}) {
  // Destinations being added right now: the dialog already closed, and each
  // holds its place until the row exists.
  const { pending } = usePendingCreate();
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<"all" | "server" | "s3">("all");
  const [status, setStatus] = React.useState<DestinationStatus | "all">("all");
  const [view, setView] = React.useState<ListView>("grid");
  const [live, setLive] = React.useState<Record<string, Live>>({});
  const router = useRouter();

  // Radix unmounts an inactive TabsContent, so this mounts exactly when the tab
  // opens. Free space is only ever measured by a test, and a figure from last
  // week is not worth a bar. Rate-limited in lib/destination-probe.ts.
  React.useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    void probeDestinations().then((rows) => {
      // A skipped or failed round leaves the stored figures in place - opening a
      // tab is not the place to raise an error nobody asked for.
      if (cancelled || !rows) return;
      setLive(
        Object.fromEntries(
          rows.map((d) => [
            d.id,
            {
              status: d.status,
              lastTestError: d.lastTestError,
              lastTestAt: d.lastTestAt,
              freeBytes: d.freeBytes,
              totalBytes: d.totalBytes,
            },
          ]),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [canManage]);

  const fresh = destinations.map((d) => ({ ...d, ...live[d.id] }));
  const q = query.trim().toLowerCase();
  const filtered = fresh.filter((d) => {
    if (kind !== "all" && d.kind !== kind) return false;
    if (status !== "all" && d.status !== status) return false;
    if (!q) return true;
    return [d.name, d.serverName, d.bucket, d.endpoint, d.resolvedPath].some(
      (v) => v?.toLowerCase().includes(q),
    );
  });

  /* ---- Multi-selection (marquee + ctrl/shift-click) + bulk actions ------- */
  // Only what is ON SCREEN is selectable, in display order, so a shift-click
  // range spans the list exactly as it reads.
  const visibleIds = filtered.map((d) => d.id);
  const selection = useCardSelection(visibleIds);
  const {
    selected,
    marqueeRef,
    canvasRef,
    onItemClick,
    clear: clearSelection,
    selectAll,
  } = selection;
  const selectedIds = visibleIds.filter((id) => selected.has(id));
  const selectionCount = selectedIds.length;
  const [bulkRemoveOpen, setBulkRemoveOpen] = React.useState(false);
  useSelectionShortcuts({
    count: selectionCount,
    selectAll,
    clear: clearSelection,
    onDelete: canManage ? () => setBulkRemoveOpen(true) : undefined,
  });

  // "1 destination" / "3 destinations" - every bulk toast and confirm names what
  // is actually selected.
  const selectionNoun = `${selectionCount} destination${selectionCount === 1 ? "" : "s"}`;

  // One mutation per selected destination - there is no bulk endpoint, and each
  // is its own probe or its own sweep. The first refusal is surfaced verbatim
  // and the selection SURVIVES it, so re-confirming retries.
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
        placeholder="Search destinations"
        view={view}
        onView={setView}
        listLabel="Table view"
        action={createButton}
        filters={
          <>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as typeof kind)}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="Kind" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                <SelectItem value="server">Server</SelectItem>
                <SelectItem value="s3">S3 bucket</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as typeof status)}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {(Object.keys(STATUS_LABELS) as DestinationStatus[]).map(
                  (s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </>
        }
      />

      <SelectionCanvas canvasRef={canvasRef} marqueeRef={marqueeRef}>
        {filtered.length === 0 && pending.length === 0 ? (
          <EmptyState
            icon={HardDrive}
            title="No matching destinations"
            description="No destination matches the current search and filters."
          />
        ) : view === "list" ? (
          <DestinationsTable
            destinations={filtered}
            canManage={canManage}
            selected={selected}
            onSelect={onItemClick}
          />
        ) : (
          <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {/* Removing one takes its card off the grid on the click; the row is
                dropped server-side before the artifacts are swept. */}
            <OptimisticList>
              {filtered.map((dest) => (
                <SelectableCard
                  key={dest.id}
                  id={dest.id}
                  selected={selected.has(dest.id)}
                  onSelect={(e) => onItemClick(dest.id, e)}
                >
                  <DestinationCard dest={dest} canManage={canManage} />
                </SelectableCard>
              ))}
            </OptimisticList>
            <PendingCards />
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
                  `mutation($id: String!) { testDestination(id: $id) { report { ok } } }`,
                  (id) => ({ id }),
                  `${selectionNoun} tested`,
                )
              }
            >
              <PlugZap className="size-4" />
              Test connection
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setBulkRemoveOpen(true)}
            >
              <Trash2 className="size-4" />
              Remove
            </Button>
          </>
        )}
      </SelectionBar>

      {/* The bulk remove never touches the artifacts: deleting the files is the
          single card's checkbox, where the count it destroys can be named. */}
      <ConfirmAction
        open={bulkRemoveOpen}
        onOpenChange={setBulkRemoveOpen}
        title={`Remove ${selectionNoun}?`}
        description={`Every backup schedule and restore point using ${selectionCount === 1 ? "it" : "them"} is deleted.`}
        consequence="The backup files themselves are kept, and only a recovery key can read them afterwards."
        confirmLabel={`Remove ${selectionCount === 1 ? "destination" : "destinations"}`}
        onConfirm={() =>
          bulkRun(
            `mutation($id: String!) { deleteDestination(id: $id) }`,
            (id) => ({ id }),
            `${selectionNoun} removed`,
          )
        }
      />
    </div>
  );
}
