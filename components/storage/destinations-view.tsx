"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { CircleDot, HardDrive, PlugZap, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { countBy, inAny } from "@/components/shared/facet-filtering";
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
const STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as DestinationStatus[]).map(
  (s) => ({ value: s, label: STATUS_LABELS[s] }),
);
const KIND_OPTIONS = [
  { value: "server", label: "Server" },
  { value: "s3", label: "S3 bucket" },
];

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
  const [kinds, setKinds] = React.useState<string[]>([]);
  const [statuses, setStatuses] = React.useState<string[]>([]);
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
    if (!inAny(kinds, [d.kind])) return false;
    if (!inAny(statuses, [d.status])) return false;
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
        facets={[
          {
            id: "kind",
            label: "Kind",
            icon: HardDrive,
            options: KIND_OPTIONS,
            values: kinds,
            counts: countBy(fresh, (d) => d.kind),
            onChange: setKinds,
          },
          {
            id: "status",
            label: "Status",
            icon: CircleDot,
            options: STATUS_OPTIONS,
            values: statuses,
            counts: countBy(fresh, (d) => d.status),
            onChange: setStatuses,
          },
        ]}
        view={view}
        onView={setView}
        listLabel="Table view"
        action={createButton}
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
