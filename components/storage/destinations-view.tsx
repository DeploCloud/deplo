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
import type { DestinationStatus } from "@/lib/types/backup";

type Live = Pick<
  DestinationCardView,
  "status" | "lastTestError" | "lastTestAt" | "freeBytes" | "totalBytes"
>;

const STATUS_LABELS: Record<DestinationStatus, string> = {
  connected: "Connected",
  error: "Error",
  unverified: "Unverified",
};

export function DestinationsView({
  destinations,
  canManage,
  createButton,
}: {
  destinations: DestinationCardView[];
  canManage: boolean;
  createButton: React.ReactNode;
}) {
  const { pending } = usePendingCreate();
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<"all" | "server" | "s3">("all");
  const [status, setStatus] = React.useState<DestinationStatus | "all">("all");
  const [view, setView] = React.useState<ListView>("grid");
  const [live, setLive] = React.useState<Record<string, Live>>({});
  const router = useRouter();

  React.useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    void probeDestinations().then((rows) => {
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

  const selectionNoun = `${selectionCount} destination${selectionCount === 1 ? "" : "s"}`;

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
          <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
