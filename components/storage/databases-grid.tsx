"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
  defaultDropAnimationSideEffects,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
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
import { DragStack } from "@/components/shared/drag-stack";
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
import type { DatabaseDTO } from "@/lib/data/databases";
import type { DatabaseStatus, DatabaseType } from "@/lib/types";

type View = ListView;

const STATUS_LABELS: Record<DatabaseStatus, string> = {
  running: "Running",
  stopped: "Stopped",
  provisioning: "Provisioning",
  error: "Error",
};

/**
 * The Storage databases grid - the databases analogue of the Overview apps grid:
 * search, engine + status filters, a grid/list view toggle, and drag-to-reorder
 * (persisted team-wide via reorderDatabases).
 */
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
  /** The team's Environments, so a card can offer "Move to environment". */
  environments?: { id: string; label: string }[];
  /** `configure_databases` - what the move is gated on. */
  canConfigure?: boolean;
  canReorder: boolean;
  /** The viewer holds `manage_infra` - the capability `revealConnection` needs. */
  canReveal: boolean;
  /** `control_databases` - gates the bulk Start / Stop / Restart. */
  canControl: boolean;
  /** `delete_databases` - gates the bulk Delete. */
  canDelete: boolean;
  /** The create button, rendered at the end of the toolbar. */
  createButton: React.ReactNode;
}) {
  const router = useRouter();
  // Databases being created right now: their dialog already closed, and each
  // holds its place in the grid as a pulsing card until the row exists.
  const { pending } = usePendingCreate();
  const [query, setQuery] = React.useState("");
  const [engine, setEngine] = React.useState<DatabaseType | "all">("all");
  const [status, setStatus] = React.useState<DatabaseStatus | "all">("all");
  const [view, setView] = React.useState<View>("grid");

  // Optimistic order, seeded from the server list (already in persisted order).
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

  // Reorder only when nothing is filtering the view (else a drop would persist a
  // partial order) and the caller may manage order.
  const reorderable = canReorder && !filtering;

  /* ---- Multi-selection (marquee + ctrl/shift-click) + bulk actions ------- */
  // Only what is ON SCREEN is selectable, in display order, so a shift-click
  // range spans the grid exactly as it reads and a filtered-out database can
  // never become a bulk target.
  const visibleIds = filtered.map((d) => d.id);
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
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);

  // One mutation per selected database - there is no bulk endpoint, and each
  // one is its own teardown/lifecycle on its own host. The first refusal is
  // surfaced verbatim and the selection SURVIVES it, so re-confirming retries.
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

  // "1 database" / "3 databases" - every bulk toast and the confirm name what
  // is actually selected, so nothing reads "Databases deleted" for one.
  const selectionNoun = `${selectedIds.length} database${selectedIds.length === 1 ? "" : "s"}`;

  const selectionCount = selectedIds.length;
  // ⌘/Ctrl+A, Esc and Delete, same as every other selectable list.
  useSelectionShortcuts({
    count: selectionCount,
    selectAll,
    clear: clearSelection,
    onDelete: canDelete ? () => setBulkDeleteOpen(true) : undefined,
  });

  // The card under the cursor, and the block travelling with it: a selection of
  // ≥2 that the lifted card belongs to moves together.
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
    // The lifted card carries its whole multi-selection; a card outside the
    // selection moves alone.
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

      <SelectionCanvas
        canvasRef={canvasRef}
        marqueeRef={marqueeRef}
        onPointerDown={onCanvasPointerDown}
      >
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
            {/* The lifted card that follows the cursor, portalled above the grid
                so it is never clipped; the original stays as a dimmed slot. */}
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

      {/* The bulk delete is the plain one: no "delete it anyway" force option,
          which stays on the single-card dialog where it belongs (it is the
          escape hatch for one database on a host that is never coming back). */}
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

// The lifted clone eases back into the settled slot while the placeholder
// (held at opacity-40) cross-fades back in.
const DRAG_DROP_ANIMATION: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

/** The three lifecycle verbs + Delete, for the shared selection bar. */
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

/** 1 / 2 / 3 cols + a list mode; database cards fit 3-up earlier than app cards. */
function gridClass(view: View): string {
  return view === "list"
    ? "flex flex-col gap-3"
    : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";
}

/**
 * A minimal sortable wrapper providing the whole-card drag (pointer listeners on
 * the wrapper) + a keyboard-accessible handle, and swallowing the trailing click
 * dnd-kit emits after a drop so a drag never navigates.
 */
function SortableCard({
  id,
  selected,
  groupDragging = false,
  onSelect,
  children,
}: {
  id: string;
  selected: boolean;
  /** This card travels with the lifted one (multi-selection drag) → dim it too. */
  groupDragging?: boolean;
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
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const { onKeyDown: keyboardListener, ...rawPointerListeners } =
    listeners ?? {};
  // Scoped to this card's own DOM: a press inside a menu or modal the card
  // rendered reaches these through the React tree even though the portal put it
  // elsewhere in the page, and must not start a drag under a backdrop.
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
    // A menu/modal this card opened is portalled out of the card's DOM but not
    // out of its React tree, and capture runs before the surface ever sees it - drop
    // anything that isn't physically inside this card (see lib/portal-event-scope.ts).
    if (!e.currentTarget.contains(e.target as Node)) return;
    const onControls = Boolean(
      (e.target as HTMLElement).closest?.("[data-card-actions]"),
    );
    // 1) Swallow the click dnd-kit emits on the dragged card after a drop.
    if (draggedRef.current) {
      draggedRef.current = false;
      if (onControls) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // 2) Modifier-click selects this card instead of opening it (spare the ⋯).
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && !onControls) {
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
        // The lifted card and every sibling moving with it dim in place, so the
        // whole group reads as picked up.
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
