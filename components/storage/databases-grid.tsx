"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Search,
  LayoutGrid,
  List,
  GripVertical,
  Database,
  Play,
  Square,
  RotateCw,
  Trash2,
  MousePointerSquareDashed,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { scopeListenersToSubtree } from "@/lib/portal-event-scope";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useCardSelection } from "@/components/shared/use-card-selection";
import {
  PendingCards,
  usePendingCreate,
} from "@/components/shared/pending-create";
import { DatabaseCard } from "@/components/storage/database-card";
import { DB_TYPES } from "@/components/storage/db-engines";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { DatabaseDTO } from "@/lib/data/databases";
import type { DatabaseStatus, DatabaseType } from "@/lib/types";

type View = "grid" | "list";

const STATUS_LABELS: Record<DatabaseStatus, string> = {
  running: "Running",
  stopped: "Stopped",
  provisioning: "Provisioning",
  error: "Error",
};

/**
 * The Storage databases grid — the databases analogue of the Overview apps grid:
 * search, engine + status filters, a grid/list view toggle, and drag-to-reorder
 * (persisted team-wide via reorderDatabases). Reorder is disabled while any
 * search/filter is active — persisting a filtered order would drop the hidden
 * databases' arrangement, exactly like the apps grid gates reorder on `!query`.
 */
export function DatabasesGrid({
  databases,
  serverNames,
  canReorder,
  canReveal,
  canControl,
  canDelete,
}: {
  databases: DatabaseDTO[];
  serverNames: Record<string, string>;
  canReorder: boolean;
  /** The viewer holds `manage_infra` — the capability `revealConnection` needs. */
  canReveal: boolean;
  /** `control_databases` — gates the bulk Start / Stop / Restart. */
  canControl: boolean;
  /** `delete_databases` — gates the bulk Delete. */
  canDelete: boolean;
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
  // The parent remounts this grid (via a membership `key`) when the SET of
  // databases changes — create/delete — so there's no reconcile effect; a plain
  // reorder keeps the same set, so the grid is NOT remounted and the optimistic
  // order survives its own drop (the same pattern the Overview apps grid uses).
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
  const {
    selected,
    marqueeRef,
    canvasRef,
    onCanvasPointerDown,
    onItemClick,
    clear: clearSelection,
    selectAll,
  } = useCardSelection(visibleIds);
  const selectedIds = visibleIds.filter((id) => selected.has(id));
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);

  // One mutation per selected database — there is no bulk endpoint, and each
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

  // "1 database" / "3 databases" — every bulk toast and the confirm name what
  // is actually selected, so nothing reads "Databases deleted" for one.
  const selectionNoun = `${selectedIds.length} database${selectedIds.length === 1 ? "" : "s"}`;

  // Page-scoped shortcuts, same as the Overview grid: ⌘/Ctrl+A selects all,
  // Esc clears, Delete/Backspace opens the bulk-delete confirm.
  const selectionCount = selectedIds.length;
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t?.closest("input, textarea, [contenteditable='true'], [role='dialog']")
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
      } else if (e.key === "Escape" && selectionCount > 0) {
        clearSelection();
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        canDelete &&
        selectionCount > 0
      ) {
        e.preventDefault();
        setBulkDeleteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionCount, selectAll, clearSelection, canDelete]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const prev = order;
    const next = arrayMove(order, from, to);
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
      <Toolbar
        query={query}
        onQuery={setQuery}
        engine={engine}
        onEngine={setEngine}
        status={status}
        onStatus={setStatus}
        view={view}
        onView={setView}
      />

      {/* The selection canvas: a relative, tall surface so there is empty space
          to start a marquee, and the coordinate space it hit-tests against. */}
      <div
        ref={canvasRef}
        onPointerDown={onCanvasPointerDown}
        className="relative min-h-[60vh] select-none"
      >
        {/* Positioned imperatively by the selection hook during a drag (no
            re-render per pointermove); hidden when idle. */}
        <div
          ref={marqueeRef}
          className="pointer-events-none absolute z-20 hidden rounded-sm border border-primary bg-primary/10"
        />
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
            onDragEnd={onDragEnd}
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
                    onSelect={(e) => onItemClick(d.id, e)}
                  >
                    {({ handle, dragActive }) => (
                      <DatabaseCard
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
      </div>

      <SelectionActionBar
        count={selectionCount}
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
        onSelectAll={selectAll}
        onClear={clearSelection}
      />

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

/** The multi-selection highlight, shared by both card wrappers below. */
const SELECTED_RING =
  "ring-2 ring-primary ring-offset-2 ring-offset-background";

/**
 * The bulk-actions bar: it floats at the bottom of the viewport whenever one or
 * more cards are selected (marquee drag / ⌘-click), exactly like the Overview's.
 * Every action is gated on the same capability its single-card twin needs, so
 * the bar never offers a button the server would refuse.
 */
function SelectionActionBar({
  count,
  canControl,
  canDelete,
  onStart,
  onStop,
  onRestart,
  onDelete,
  onSelectAll,
  onClear,
}: {
  count: number;
  canControl: boolean;
  canDelete: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/95 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-popover/80">
        <span className="text-sm font-medium whitespace-nowrap">
          {count} selected
        </span>
        <span className="mx-1.5 h-5 w-px bg-border" />
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
        <span className="mx-1.5 h-5 w-px bg-border" />
        <Button variant="ghost" size="sm" onClick={onSelectAll}>
          <MousePointerSquareDashed className="size-4" />
          Select all
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear selection"
          onClick={onClear}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The card wrapper used when reorder is off (filtering, or no capability): the
 * same selection surface {@link SortableCard} provides — the marquee's
 * `data-card-id` target, the highlight, and modifier-click instead of navigation
 * — without dnd-kit.
 */
function SelectableCard({
  id,
  selected,
  onSelect,
  children,
}: {
  id: string;
  selected: boolean;
  onSelect: (e: {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
  }) => boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-card-id={id}
      onClickCapture={(e: React.MouseEvent<HTMLDivElement>) => {
        // A menu or dialog this card opened is portalled out of its DOM but not
        // out of its React tree (see lib/portal-event-scope.ts).
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (!(e.metaKey || e.ctrlKey || e.shiftKey)) return;
        if ((e.target as HTMLElement).closest?.("[data-card-actions]")) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect(e);
      }}
      className={cn(
        "touch-manipulation rounded-xl select-none",
        selected && SELECTED_RING,
      )}
    >
      {children}
    </div>
  );
}

/** 1 / 2 / 3 cols + a list mode; database cards fit 3-up earlier than app cards. */
function gridClass(view: View): string {
  return view === "list"
    ? "flex flex-col gap-3"
    : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";
}

function Toolbar({
  query,
  onQuery,
  engine,
  onEngine,
  status,
  onStatus,
  view,
  onView,
}: {
  query: string;
  onQuery: (v: string) => void;
  engine: DatabaseType | "all";
  onEngine: (v: DatabaseType | "all") => void;
  status: DatabaseStatus | "all";
  onStatus: (v: DatabaseStatus | "all") => void;
  view: View;
  onView: (v: View) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search databases"
          className="pl-9"
        />
      </div>
      <Select
        value={engine}
        onValueChange={(v) => onEngine(v as DatabaseType | "all")}
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
        onValueChange={(v) => onStatus(v as DatabaseStatus | "all")}
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
      <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
        <SimpleTooltip content="Grid view">
          <Button
            variant={view === "grid" ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() => onView("grid")}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
          >
            <LayoutGrid className="size-4" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip content="List view">
          <Button
            variant={view === "list" ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() => onView("list")}
            aria-label="List view"
            aria-pressed={view === "list"}
          >
            <List className="size-4" />
          </Button>
        </SimpleTooltip>
      </div>
    </div>
  );
}

/**
 * A minimal sortable wrapper providing the whole-card drag (pointer listeners on
 * the wrapper) + a keyboard-accessible handle, and swallowing the trailing click
 * dnd-kit emits after a drop so a drag never navigates. Render-props deliver the
 * handle node and a `dragActive` flag to the card.
 */
function SortableCard({
  id,
  selected,
  onSelect,
  children,
}: {
  id: string;
  selected: boolean;
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
    // out of its React tree, and capture runs before the surface ever sees it — drop
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
        isDragging && "relative z-10 opacity-80",
      )}
      {...wrapperAttributes}
      {...pointerListeners}
    >
      {children({ handle, dragActive: isDragging })}
    </div>
  );
}
