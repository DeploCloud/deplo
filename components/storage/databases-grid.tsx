"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Database,
  Play,
  Square,
  RotateCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { scopeListenersToSubtree } from "@/lib/portal-event-scope";
import { ListToolbar, type ListView } from "@/components/shared/list-toolbar";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useCardSelection } from "@/components/shared/use-card-selection";
import {
  SelectableCard,
  SelectionBar,
  SelectionCanvas,
  SELECTED_RING,
  useSelectionShortcuts,
} from "@/components/shared/card-selection";
import { DragStack, DRAG_DROP_ANIMATION } from "@/components/shared/drag-stack";
import {
  PendingCards,
  usePendingCreate,
} from "@/components/shared/pending-create";
import { DatabaseCard } from "@/components/storage/database-card";
import { DB_TYPES } from "@/components/storage/db-engines";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { gqlAction } from "@/lib/graphql-client";
import { reorderBlock } from "@/lib/reorder-block";
import { cn } from "@/lib/utils";
import type { DatabaseDTO } from "@/lib/data/databases/rows";
import type { DatabaseStatus, DatabaseType } from "@/lib/types/database";

type View = ListView;

const STATUS_LABELS: Record<DatabaseStatus, string> = {
  running: "Running",
  stopped: "Stopped",
  provisioning: "Provisioning",
  error: "Error",
};

export function DatabasesGrid({
  databases,
  serverNames,
  canReorder,
  canReveal,
  canControl,
  canDelete,
  createButton,
  environments = [],
  canConfigure = false,
}: {
  databases: DatabaseDTO[];
  serverNames: Record<string, string>;
  environments?: { id: string; label: string }[];
  canConfigure?: boolean;
  canReorder: boolean;
  canReveal: boolean;
  canControl: boolean;
  canDelete: boolean;
  createButton: React.ReactNode;
}) {
  const router = useRouter();
  const { pending } = usePendingCreate();
  const [query, setQuery] = React.useState("");
  const [engine, setEngine] = React.useState<DatabaseType | "all">("all");
  const [status, setStatus] = React.useState<DatabaseStatus | "all">("all");
  const [view, setView] = React.useState<View>("grid");

  const [order, setOrder] = React.useState<string[]>(() =>
    databases.map((d) => d.id),
  );

  const byId = React.useMemo(
    () => new Map(databases.map((d) => [d.id, d] as const)),
    [databases],
  );
  const ordered = order
    .map((id) => byId.get(id))
    .filter(Boolean) as DatabaseDTO[];

  const q = query.trim().toLowerCase();
  const filtering = q !== "" || engine !== "all" || status !== "all";
  const filtered = ordered.filter((d) => {
    if (engine !== "all" && d.type !== engine) return false;
    if (status !== "all" && d.status !== status) return false;
    if (!q) return true;
    return (
      d.name.toLowerCase().includes(q) ||
      d.type.toLowerCase().includes(q) ||
      d.host.toLowerCase().includes(q)
    );
  });

  // Only when nothing is filtering: a drop on a filtered view would persist a partial order.
  const reorderable = canReorder && !filtering;

  const visibleIds = filtered.filter((d) => !d.migrationRunId).map((d) => d.id);
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
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);

  async function bulkRun(mutation: string, success: string) {
    const ids = selectedIds;
    const results = await Promise.all(
      ids.map((id) => gqlAction(mutation, { id })),
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

  const selectionNoun = `${selectedIds.length} database${selectedIds.length === 1 ? "" : "s"}`;

  const selectionCount = selectedIds.length;
  useSelectionShortcuts({
    count: selectionCount,
    selectAll,
    clear: clearSelection,
    onDelete: canDelete ? () => setBulkDeleteOpen(true) : undefined,
  });

  const [activeId, setActiveId] = React.useState<string | null>(null);
  const dragGroup = (id: string) =>
    selectedIds.length >= 2 && selectedIds.includes(id) ? selectedIds : [id];
  const activeGroup = activeId ? dragGroup(activeId) : [];
  const groupDragIds = new Set(activeGroup.length >= 2 ? activeGroup : []);
  const activeDb = activeId ? byId.get(activeId) : undefined;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const next = reorderBlock(
      order,
      String(active.id),
      String(over.id),
      dragGroup(String(active.id)),
    );
    if (!next) return;
    const prev = order;
    setOrder(next);
    void gqlAction(
      `mutation($ids: [ID!]!) { reorderDatabases(databaseIds: $ids) }`,
      { ids: next },
    ).then((res) => {
      if (res.ok) router.refresh();
      else {
        setOrder(prev);
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <ListToolbar
        query={query}
        onQuery={setQuery}
        placeholder="Search databases"
        view={view}
        onView={setView}
        action={createButton}
        filters={
          <>
            <Select
              value={engine}
              onValueChange={(v) => setEngine(v as DatabaseType | "all")}
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Engine" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All engines</SelectItem>
                {DB_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <span className="flex items-center gap-2">
                      <DatabaseLogo type={t.id} size={16} />
                      {t.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as DatabaseStatus | "all")}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {(Object.keys(STATUS_LABELS) as DatabaseStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

      <SelectionCanvas canvasRef={canvasRef} marqueeRef={marqueeRef}>
        {filtered.length === 0 && pending.length === 0 ? (
          <EmptyState
            icon={Database}
            title="No matching databases"
            description="No database matches the current search and filters."
          />
        ) : reorderable ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={(e: DragStartEvent) =>
              setActiveId(String(e.active.id))
            }
            onDragEnd={onDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <SortableContext
              items={filtered.map((d) => d.id)}
              strategy={rectSortingStrategy}
            >
              <div className={gridClass(view)}>
                {filtered.map((d) => (
                  <SortableCard
                    key={d.id}
                    id={d.id}
                    selected={selected.has(d.id)}
                    groupDragging={groupDragIds.has(d.id)}
                    locked={Boolean(d.migrationRunId)}
                    onSelect={(e) => onItemClick(d.id, e)}
                  >
                    {({ handle, dragActive }) => (
                      <DatabaseCard
                        environments={environments}
                        canConfigure={canConfigure}
                        db={d}
                        serverName={serverNames[d.serverId]}
                        view={view}
                        dragHandle={handle}
                        dragActive={dragActive}
                        pollMs={view === "list" ? 20000 : 15000}
                        canReveal={canReveal}
                      />
                    )}
                  </SortableCard>
                ))}
                <PendingCards />
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={DRAG_DROP_ANIMATION}>
              {activeDb ? (
                <DragStack count={activeGroup.length}>
                  <DatabaseCard
                    environments={environments}
                    canConfigure={canConfigure}
                    db={activeDb}
                    serverName={serverNames[activeDb.serverId]}
                    view={view}
                    dragActive
                    canReveal={canReveal}
                  />
                </DragStack>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <div className={gridClass(view)}>
            {filtered.map((d) => (
              <SelectableCard
                key={d.id}
                id={d.id}
                selected={selected.has(d.id)}
                onSelect={(e) => onItemClick(d.id, e)}
              >
                <DatabaseCard
                  environments={environments}
                  canConfigure={canConfigure}
                  db={d}
                  serverName={serverNames[d.serverId]}
                  view={view}
                  pollMs={view === "list" ? 20000 : 15000}
                  canReveal={canReveal}
                />
              </SelectableCard>
            ))}
            <PendingCards />
          </div>
        )}
      </SelectionCanvas>

      <SelectionBar
        count={selectionCount}
        onSelectAll={selectAll}
        onClear={clearSelection}
      >
        <DatabaseBulkActions
          canControl={canControl}
          canDelete={canDelete}
          onStart={() =>
            void bulkRun(
              `mutation($id: String!) { setDatabaseRunning(id: $id, running: true) { id } }`,
              `${selectionNoun} started`,
            )
          }
          onStop={() =>
            void bulkRun(
              `mutation($id: String!) { setDatabaseRunning(id: $id, running: false) { id } }`,
              `${selectionNoun} stopped`,
            )
          }
          onRestart={() =>
            void bulkRun(
              `mutation($id: String!) { restartDatabase(id: $id) { id } }`,
              `${selectionNoun} restarted`,
            )
          }
          onDelete={() => setBulkDeleteOpen(true)}
        />
      </SelectionBar>

      <ConfirmAction
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${selectionNoun}?`}
        description={`${selectionCount === 1 ? "This database is" : "These databases are"} stopped, and their containers, all their data and every backup they have stored are permanently destroyed.`}
        confirmLabel={`Delete ${selectionCount === 1 ? "database" : "databases"}`}
        onConfirm={() => bulkRun(DELETE_DATABASE, `${selectionNoun} deleted`)}
      />
    </div>
  );
}

const DELETE_DATABASE = `mutation($id: String!) { deleteDatabase(id: $id) }`;

function DatabaseBulkActions({
  canControl,
  canDelete,
  onStart,
  onStop,
  onRestart,
  onDelete,
}: {
  canControl: boolean;
  canDelete: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      {canControl && (
        <>
          <Button variant="ghost" size="sm" onClick={onStart}>
            <Play className="size-4" />
            Start
          </Button>
          <Button variant="ghost" size="sm" onClick={onStop}>
            <Square className="size-4" />
            Stop
          </Button>
          <Button variant="ghost" size="sm" onClick={onRestart}>
            <RotateCw className="size-4" />
            Restart
          </Button>
        </>
      )}
      {canDelete && (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
          Delete
        </Button>
      )}
    </>
  );
}

function gridClass(view: View): string {
  return view === "list"
    ? "flex flex-col gap-3"
    : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3";
}

function SortableCard({
  id,
  selected,
  groupDragging = false,
  locked = false,
  onSelect,
  children,
}: {
  id: string;
  selected: boolean;
  groupDragging?: boolean;
  locked?: boolean;
  onSelect: (e: {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
  }) => boolean;
  children: (opts: {
    handle: React.ReactNode;
    dragActive: boolean;
  }) => React.ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: locked });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const { onKeyDown: keyboardListener, ...rawPointerListeners } =
    listeners ?? {};
  const pointerListeners = scopeListenersToSubtree(rawPointerListeners);
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    role: _role,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    "aria-roledescription": _rd,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    "aria-pressed": _ap,
    ...wrapperAttributes
  } = attributes;

  const draggedRef = React.useRef(false);
  React.useEffect(() => {
    if (isDragging) {
      draggedRef.current = true;
      return;
    }
    const t = window.setTimeout(() => {
      draggedRef.current = false;
    }, 300);
    return () => window.clearTimeout(t);
  }, [isDragging]);

  function onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.target as Node)) return;
    const onControls = Boolean(
      (e.target as HTMLElement).closest?.("[data-card-actions]"),
    );
    if (draggedRef.current) {
      draggedRef.current = false;
      if (onControls) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && !locked && !onControls) {
      e.preventDefault();
      e.stopPropagation();
      onSelect(e);
    }
  }

  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      aria-label="Drag to reorder"
      className="cursor-grab rounded-md p-1 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 active:cursor-grabbing"
      onClick={(e) => e.preventDefault()}
      onKeyDown={keyboardListener as React.KeyboardEventHandler}
      {...attributes}
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-card-id={id}
      onClickCapture={onClickCapture}
      className={cn(
        "touch-manipulation rounded-xl select-none [-webkit-touch-callout:none]",
        selected && SELECTED_RING,
        (isDragging || groupDragging) &&
          "opacity-40 transition-opacity duration-150",
        isDragging && "relative z-10",
      )}
      {...wrapperAttributes}
      {...pointerListeners}
    >
      {children({ handle, dragActive: isDragging })}
    </div>
  );
}
