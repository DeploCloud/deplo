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
import { Search, LayoutGrid, List, GripVertical, Database } from "lucide-react";
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
import { EmptyState } from "@/components/shared/empty-state";
import { DatabaseCard } from "@/components/storage/database-card";
import { DB_TYPES } from "@/components/storage/db-engines";
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
}: {
  databases: DatabaseDTO[];
  serverNames: Record<string, string>;
  canReorder: boolean;
}) {
  const router = useRouter();
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
  const ordered = order.map((id) => byId.get(id)).filter(Boolean) as DatabaseDTO[];

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

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
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

      {filtered.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No matching databases"
          description="No database matches the current search and filters."
        />
      ) : reorderable ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={filtered.map((d) => d.id)} strategy={rectSortingStrategy}>
            <div className={gridClass(view)}>
              {filtered.map((d) => (
                <SortableCard key={d.id} id={d.id}>
                  {({ handle, dragActive }) => (
                    <DatabaseCard
                      db={d}
                      serverName={serverNames[d.serverId]}
                      view={view}
                      dragHandle={handle}
                      dragActive={dragActive}
                      pollMs={view === "list" ? 20000 : 15000}
                    />
                  )}
                </SortableCard>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className={gridClass(view)}>
          {filtered.map((d) => (
            <DatabaseCard
              key={d.id}
              db={d}
              serverName={serverNames[d.serverId]}
              view={view}
              pollMs={view === "list" ? 20000 : 15000}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Mirrors the Overview grid's responsive scheme (1 / 2 / 3 cols) + a list mode. */
function gridClass(view: View): string {
  return view === "list"
    ? "flex flex-col gap-3"
    : "grid gap-4 sm:grid-cols-2 3xl:grid-cols-3";
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
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search databases…"
          className="pl-9"
        />
      </div>
      <Select value={engine} onValueChange={(v) => onEngine(v as DatabaseType | "all")}>
        <SelectTrigger className="w-full sm:w-40">
          <SelectValue placeholder="Engine" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All engines</SelectItem>
          {DB_TYPES.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              <span className="flex items-center gap-2">
                <t.icon className="size-4 text-muted-foreground" />
                {t.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={status} onValueChange={(v) => onStatus(v as DatabaseStatus | "all")}>
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
  children,
}: {
  id: string;
  children: (opts: { handle: React.ReactNode; dragActive: boolean }) => React.ReactNode;
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

  const { onKeyDown: keyboardListener, ...pointerListeners } = listeners ?? {};
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
    const onControls = Boolean(
      (e.target as HTMLElement).closest?.("[data-card-actions]"),
    );
    if (draggedRef.current) {
      draggedRef.current = false;
      if (onControls) return;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      aria-label="Drag to reorder"
      className="cursor-grab rounded-md p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
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
      onClickCapture={onClickCapture}
      className={cn(
        "touch-manipulation select-none rounded-xl [-webkit-touch-callout:none]",
        isDragging && "relative z-10 opacity-80",
      )}
      {...wrapperAttributes}
      {...pointerListeners}
    >
      {children({ handle, dragActive: isDragging })}
    </div>
  );
}
