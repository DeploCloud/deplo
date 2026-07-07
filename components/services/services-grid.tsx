"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronLeft,
  GripVertical,
  FolderPlus,
  FolderInput,
  MousePointerSquareDashed,
  Trash2,
  X,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  defaultDropAnimationSideEffects,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ServiceCard } from "./service-card";
import { FolderCard, folderHref, type FolderCardData } from "./folder-card";
import {
  ProjectContainerCard,
  type ProjectCardData,
} from "./project-container-card";
import { CreateFolderDialog } from "./create-folder-dialog";
import { useOverviewSelection } from "./use-overview-selection";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { ServiceSummary } from "@/lib/data/services";

const REORDER_SERVICES = `mutation($ids: [ID!]!) { reorderServices(serviceIds: $ids) }`;
const REORDER_FOLDERS = `mutation($ids: [ID!]!) { reorderFolders(folderIds: $ids) }`;
const REORDER_PROJECT_CONTAINERS = `mutation($ids: [ID!]!) { reorderProjects(projectIds: $ids) }`;
const MOVE_TO_FOLDER = `mutation($serviceId: ID!, $folderId: ID) { moveServiceToFolder(serviceId: $serviceId, folderId: $folderId) }`;
const MOVE_SERVICE_TO_PROJECT = `mutation($serviceId: ID!, $projectId: ID) { moveServiceToProject(serviceId: $serviceId, projectId: $projectId) }`;
const DELETE_FOLDER = `mutation($id: ID!) { deleteFolder(id: $id) }`;
// Bulk variants: each is ONE server round-trip + ONE store write for the whole
// selection (instead of N fanned-out per-id mutations).
const BULK_MOVE = `mutation($ids: [ID!]!, $folderId: ID) { moveServicesToFolder(serviceIds: $ids, folderId: $folderId) }`;
const BULK_DELETE = `mutation($ids: [ID!]!) { deleteServices(ids: $ids) }`;

// Sentinel droppable id for the breadcrumb "drop here to leave the folder" zone.
const UNGROUP_DROP_ID = "__ungroup__";

// Drop animation for the drag overlay: the lifted clone eases back into the
// settled slot while the placeholder (held at opacity-40) cross-fades back in.
const DRAG_DROP_ANIMATION: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

type FolderRef = { id: string; name: string };
type ProjectRef = { id: string; name: string };
/** One breadcrumb segment; `href` overrides the default folder link (used for
 *  the project segment, which opens `/?project=<id>` instead of a folder). */
export type TrailSeg = { id: string; name: string; href?: string };

function gridClass(view: "grid" | "list"): string {
  // Grid view: 1 col on mobile, 2 on small/medium, 3 from lg up — applied to
  // every grouped surface (Overview, folder contents, sub-folders, projects).
  return view === "list"
    ? "flex flex-col gap-3"
    : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3";
}

function allServicesHref(view: "grid" | "list"): string {
  return view === "list" ? "/?view=list" : "/";
}

/** Selection-aware bulk actions, composed by the grid that owns the selection. */
interface SelectionBulk {
  count: number;
  onSelectAll: () => void;
  onClear: () => void;
  onDelete: () => void;
  onNewFolderWithSelection: () => void;
  moveTargets: FolderRef[];
  onMoveTo: (folderId: string | null) => void;
}

/**
 * The dynamic BULK-actions bar. It floats at the bottom of the viewport whenever
 * one or more cards are selected (marquee drag / ⌘-click), replacing what used to
 * be a right-click menu. "New folder with selection" is a CREATE action (gated on
 * `canCreateFolder`); the team-wide Move / Delete are gated on `canManageAllFolders`.
 * Select all + Clear are always shown. Keyboard shortcuts (⌘A / Esc / ⌫) stay wired
 * on the grid regardless of the bar. This is the one place the bulk actions live.
 */
function SelectionActionBar({
  selection,
  canCreateFolder,
  canManageAllFolders,
}: {
  selection: SelectionBulk;
  canCreateFolder: boolean;
  canManageAllFolders: boolean;
}) {
  if (selection.count === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/95 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-popover/80">
        <span className="whitespace-nowrap text-sm font-medium">
          {selection.count} selected
        </span>
        <span className="mx-1.5 h-5 w-px bg-border" />
        {canCreateFolder && (
          <Button
            variant="ghost"
            size="sm"
            onClick={selection.onNewFolderWithSelection}
          >
            <FolderPlus className="size-4" />
            New folder
          </Button>
        )}
        {canManageAllFolders && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <FolderInput className="size-4" />
                  Move to
                  <ChevronDown className="size-3.5 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="center"
                className="max-h-72 w-52 overflow-y-auto"
              >
                <DropdownMenuItem onSelect={() => selection.onMoveTo(null)}>
                  Ungrouped
                </DropdownMenuItem>
                {selection.moveTargets.length > 0 && <DropdownMenuSeparator />}
                {selection.moveTargets.map((f) => (
                  <DropdownMenuItem
                    key={f.id}
                    onSelect={() => selection.onMoveTo(f.id)}
                  >
                    {f.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={selection.onDelete}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </>
        )}
        <span className="mx-1.5 h-5 w-px bg-border" />
        <Button variant="ghost" size="sm" onClick={selection.onSelectAll}>
          <MousePointerSquareDashed className="size-4" />
          Select all
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear selection"
          onClick={selection.onClear}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export interface ServicesGridProps {
  /**
   * The services to DISPLAY: a folder's contents (when one is open), the
   * ungrouped top level, or flat search results. The card objects always come
   * from the latest server props, so per-card fields stay fresh.
   */
  services: ServiceSummary[];
  /**
   * The FULL team project order (all folders), ids only. A within-group reorder
   * is persisted against this so the other groups' relative order is preserved.
   */
  allServiceIds: string[];
  /** Folder cards to show before the services (top level only; [] otherwise). */
  folders: FolderCardData[];
  /** Project CONTAINER cards, shown above the folders (team top level only; []
   *  inside a folder/project or during a search). */
  projects: ProjectCardData[];
  /** Every team folder (id + name) for the cards' "Move to folder" menu. */
  allFolders: FolderRef[];
  /** The folder currently open (with its parent, for "move out"), or null at the
   *  top level. */
  openFolder: (FolderRef & { parentId: string | null }) | null;
  /** The project container currently open (drill-in view), or null. Mutually
   *  exclusive with `openFolder` — a folder param wins over a project param. */
  openProject: ProjectRef | null;
  /** Breadcrumb trail from the top level down to the open folder or project. */
  folderPath: TrailSeg[];
  view: "grid" | "list";
  /** Drag-to-reorder + drag-into-folder are enabled (gated; off during search). */
  canReorder: boolean;
  /** The viewer may CREATE folders (has `deploy`, or is an instance admin) —
   *  gates the "New ▸ Folder" and "New folder with selection" affordances. */
  canCreateFolder: boolean;
  /** The viewer is a super-user (manage_team / instance admin) — gates the
   *  team-wide bulk move/delete, reorder, and the manage menu on folders they
   *  don't own. Per-folder manage is derived from each folder's own capabilities. */
  canManageAllFolders: boolean;
  /** The viewer may mutate project containers (holds `deploy`, or is an
   *  instance admin) — gates each project card's rename/colour/delete menu and
   *  the service cards' "Move to environment" action. */
  canManageProjects: boolean;
  /** The open project's environments — set only in the drill-in view, where it
   *  feeds each service card's "Move to environment" submenu (ADR-0009). */
  environments?: { id: string; name: string }[];
}

/**
 * Overview project grid with team-wide drag-to-reorder, folders, and
 * drag-into-folder.
 *
 * Reordering writes a team-level order (everyone sees the same arrangement), so
 * it is only enabled for users who may change it — an instance admin or a member
 * with `manage_team` — surfaced via `canReorder`. When that is false (or a search
 * narrows the list) the grid renders statically, with no dnd-kit machinery.
 *
 * Reordering is purely DRAG-BOUND: there is no toolbar, no instructional banner,
 * and no lingering "edit"/jiggle mode. Cards jiggle only while a drag is in
 * flight and settle the instant the pointer is released (onDragEnd/onDragCancel).
 */
export function ServicesGrid(props: ServicesGridProps) {
  if (!props.canReorder) return <StaticGrid {...props} />;
  return <SortableGrid {...props} />;
}

/* ------------------------------------------------------------------ */
/* Static (no reorder): search results, or no permission              */
/* ------------------------------------------------------------------ */

function StaticGrid({
  services,
  folders,
  projects,
  allFolders,
  openFolder,
  openProject,
  folderPath,
  view,
  canManageAllFolders,
  canManageProjects,
  environments,
}: ServicesGridProps) {
  return (
    <div className="relative min-h-[40vh] space-y-6">
      {/* px-1 py-1 mirrors the DroppableBreadcrumb padding so the trail sits
          in the same spot whether or not the grid is drag-reorderable. */}
      {(openFolder || openProject) && (
        <div className="px-1 py-1">
          <FolderTrail path={folderPath} view={view} />
        </div>
      )}
      {/* Projects and folders share one grid — projects first, then folders,
          on the same level (ADR-0009). */}
      {(projects.length > 0 || folders.length > 0) && (
        <div className={gridClass(view)}>
          {projects.map((p) => (
            <ProjectContainerCard
              key={p.id}
              project={p}
              view={view}
              canManage={canManageProjects}
            />
          ))}
          {folders.map((f) => (
            <FolderCard
              key={f.id}
              folder={f}
              view={view}
              isAdminOverride={canManageAllFolders}
              folders={allFolders}
            />
          ))}
        </div>
      )}
      {/* Ungrouped services always get their own separate grid, same size. */}
      {services.length > 0 && (
        <div className={gridClass(view)}>
          {services.map((p) => (
            <ServiceCard
              key={p.id}
              project={p}
              view={view}
              folders={allFolders}
              canManageFolders={canManageAllFolders}
              environments={canManageProjects ? environments : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The drill-in breadcrumb: "Overview / A / B / Current". Every ancestor segment
 * links to that level; the last (current) folder or project is plain text. A
 * segment can carry its own `href` (the project segment links to `/?project=`).
 *
 * Exported so an EMPTY open folder/project (which renders a full-page empty
 * state instead of this grid) can still show the same trail above it — the
 * breadcrumb is the only way back out, so it must survive having no contents.
 */
export function FolderTrail({
  path,
  view,
}: {
  path: TrailSeg[];
  view: "grid" | "list";
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <Link
        href={allServicesHref(view)}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Overview
      </Link>
      {path.map((seg, i) => {
        const last = i === path.length - 1;
        return (
          <React.Fragment key={seg.id}>
            <span className="text-muted-foreground/50">/</span>
            {last ? (
              <span className="font-medium">{seg.name}</span>
            ) : (
              <Link
                href={seg.href ?? folderHref(seg.id, view)}
                className="text-muted-foreground hover:text-foreground"
              >
                {seg.name}
              </Link>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sortable (reorder + drag-into-folder)                               */
/* ------------------------------------------------------------------ */

function SortableGrid({
  services,
  allServiceIds,
  folders,
  projects,
  allFolders,
  openFolder,
  openProject,
  folderPath,
  view,
  canCreateFolder,
  canManageAllFolders,
  canManageProjects,
  environments,
}: ServicesGridProps) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();

  // Local optimistic order for snappy moves. The order arrays are the sole
  // source of arrangement; the card objects always come from props (so status
  // etc. stay fresh). The parent keys this component on the *membership* of the
  // grid (the sets of project + folder ids), so a reorder/move never remounts
  // it — letting the drag survive a drop — while add/remove re-seeds.
  const [order, setOrder] = React.useState<string[]>(() => allServiceIds);
  const [folderOrder, setFolderOrder] = React.useState<string[]>(() =>
    folders.map((f) => f.id),
  );
  const [projectOrder, setProjectOrder] = React.useState<string[]>(() =>
    projects.map((p) => p.id),
  );
  // Services AND folders optimistically hidden from the current view while a
  // move (into a folder or a project container) round-trips. Cleared whenever
  // the visible projection actually changes (the refresh landing, or navigating
  // in/out of a folder/project) — see the render-time reset below.
  const [movedIds, setMovedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  // The id being dragged (null when idle). Drives the drag-bound jiggle and the
  // folder drop-target highlight; cleared on release so nothing lingers.
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const dragging = activeId !== null;
  // The droppable the pointer is currently over (tracked during the drag) — used
  // to shrink the dragged card into a folder it's hovering.
  const [overId, setOverId] = React.useState<string | null>(null);

  const byId = React.useMemo(
    () => new Map(services.map((p) => [p.id, p])),
    [services],
  );
  const folderById = React.useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );
  const projectById = React.useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  // Clear optimistic move-hides whenever the visible projection actually changes
  // — the move's refresh landing, or navigating in/out of a folder. Done in
  // render via the previous-value pattern (not an effect) so it never triggers a
  // cascading render; a pending move keeps its hide until its own refresh lands.
  const sig = [
    ...services.map((p) => `${p.id}:${p.folderId ?? ""}`),
    ...folders.map((f) => `${f.id}:${f.parentId ?? ""}`),
  ].join(",");
  const [prevSig, setPrevSig] = React.useState(sig);
  if (sig !== prevSig) {
    setPrevSig(sig);
    setMovedIds(new Set());
  }

  // The folders to render, in local order, dropping stale ids and appending any
  // the local order hasn't seen yet (a freshly created folder). Anything
  // optimistically moved into a project is hidden until its refresh lands.
  const folderItems = React.useMemo(() => {
    const ordered = folderOrder
      .map((id) => folderById.get(id))
      .filter((f): f is FolderCardData => f != null && !movedIds.has(f.id));
    const known = new Set(folderOrder);
    return [
      ...ordered,
      ...folders.filter((f) => !known.has(f.id) && !movedIds.has(f.id)),
    ];
  }, [folderOrder, folderById, folders, movedIds]);

  const folderIdSet = React.useMemo(
    () => new Set(folderItems.map((f) => f.id)),
    [folderItems],
  );

  // Project container cards, in local order (same contract as folderItems).
  const projectItems = React.useMemo(() => {
    const ordered = projectOrder
      .map((id) => projectById.get(id))
      .filter((p): p is ProjectCardData => p != null);
    const known = new Set(projectOrder);
    return [...ordered, ...projects.filter((p) => !known.has(p.id))];
  }, [projectOrder, projectById, projects]);

  const projectIdSet = React.useMemo(
    () => new Set(projectItems.map((p) => p.id)),
    [projectItems],
  );

  // The visible services, in the full local order, filtered to the displayed
  // group (everything in `byId`) minus anything optimistically moved away.
  const items = React.useMemo(() => {
    const ordered = order
      .map((id) => byId.get(id))
      .filter(
        (p): p is ServiceSummary => p != null && !movedIds.has(p.id),
      );
    const known = new Set(order);
    return [
      ...ordered,
      ...services.filter((p) => !known.has(p.id) && !movedIds.has(p.id)),
    ];
  }, [order, byId, services, movedIds]);

  const activeIsFolder = activeId !== null && folderIdSet.has(activeId);
  const activeIsProject = activeId !== null && projectIdSet.has(activeId);
  const activeIsService =
    activeId !== null && !activeIsFolder && !activeIsProject;
  // The actual card behind the floating drag clone (the lifted card that tracks
  // the cursor).
  const activeFolder = activeId ? folderById.get(activeId) ?? null : null;
  const activeProject = activeId ? projectById.get(activeId) ?? null : null;
  const activeService = activeIsService ? byId.get(activeId!) ?? null : null;
  // A dragged service hovering a container it can be dropped INTO (a folder or
  // a project card) → it shrinks (scale-0) as a preview of being absorbed; it
  // grows back the moment it leaves.
  const draggedOverFolder =
    activeIsService &&
    overId != null &&
    (folderIdSet.has(overId) || projectIdSet.has(overId));

  /* ---- Multi-selection (marquee + ctrl/shift-click) + bulk actions ------- */
  // Selectable ids in display order: folders first, then the visible services.
  const selectableIds = React.useMemo(
    () => [...folderItems.map((f) => f.id), ...items.map((p) => p.id)],
    [folderItems, items],
  );
  const {
    selected,
    marqueeRef,
    canvasRef,
    onCanvasPointerDown,
    onItemClick,
    clear: clearSelection,
    selectAll,
  } = useOverviewSelection(selectableIds);

  // Only ever count / act on selected ids that are STILL on screen, in display
  // order. A card moved into a folder (or deleted) without a remount leaves a
  // stale id in `selected`; intersecting with the currently-selectable ids keeps
  // the count honest and stops a stale id from becoming a bulk target.
  const effectiveSelected = React.useMemo(
    () => selectableIds.filter((id) => selected.has(id)),
    [selectableIds, selected],
  );
  const selectionCount = effectiveSelected.length;

  const [createFolderOpen, setCreateFolderOpen] = React.useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  // When true, the create-folder dialog moves the current selection into the
  // freshly-created folder ("New folder with selection").
  const [folderTakesSelection, setFolderTakesSelection] = React.useState(false);

  const selectedServiceIds = () =>
    effectiveSelected.filter((id) => !folderIdSet.has(id));
  const selectedFolderIds = () =>
    effectiveSelected.filter((id) => folderIdSet.has(id));

  function bulkMoveTo(folderId: string | null) {
    const ids = selectedServiceIds();
    if (ids.length === 0) return;
    startTransition(async () => {
      const res = await gqlAction(BULK_MOVE, { ids, folderId });
      if (res.ok) {
        toast.success(
          `Moved ${ids.length} project${ids.length === 1 ? "" : "s"}`,
        );
        clearSelection();
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // `onCreated` for the "New folder with selection" flow: move the selected
  // services into the folder the dialog just created (one bulk call).
  async function moveSelectionInto(folderId: string) {
    const ids = selectedServiceIds();
    if (ids.length) await gqlAction(BULK_MOVE, { ids, folderId });
    clearSelection();
  }

  async function bulkDelete() {
    const serviceIds = selectedServiceIds();
    const folderIds = selectedFolderIds();
    // Services go through ONE bulk mutation (one server write, bounded-
    // concurrency teardown); folders (usually few) delete per id.
    const results = await Promise.all([
      ...(serviceIds.length ? [gqlAction(BULK_DELETE, { ids: serviceIds })] : []),
      ...folderIds.map((id) => gqlAction(DELETE_FOLDER, { id })),
    ]);
    router.refresh();
    const failed = results.find((r) => !r.ok);
    // Clear only on FULL success: a partial failure keeps the still-selected
    // items so re-confirming retries them and the error stays meaningful.
    if (!failed) clearSelection();
    return failed ?? { ok: true as const, data: undefined };
  }

  function openNewFolder(withSelection: boolean) {
    setFolderTakesSelection(withSelection);
    setCreateFolderOpen(true);
  }

  // Page-scoped keyboard shortcuts: Ctrl/Cmd+A selects all, Esc clears, Delete /
  // Backspace opens the bulk-delete confirm. Ignored while typing or in a dialog.
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
        selectionCount > 0 &&
        canManageAllFolders
      ) {
        e.preventDefault();
        setBulkDeleteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionCount, selectAll, clearSelection, canManageAllFolders]);

  const sensors = useSensors(
    // Mouse: a few px of travel before a drag begins, so a click still navigates
    // rather than starting a reorder.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // Touch: a short hold before a drag begins, so a tap navigates and a brief
    // rest-then-swipe still scrolls the page; only a deliberate hold-and-drag
    // reorders. Releasing always ends the drag — there is no separate hold-to-
    // edit gesture any more.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function persistReorder(
    mutation: string,
    ids: string[],
    revert: () => void,
  ) {
    startTransition(async () => {
      const res = await gqlAction(mutation, { ids });
      if (res.ok) router.refresh();
      else {
        toast.error(res.error);
        revert();
      }
    });
  }

  function moveService(serviceId: string, folderId: string | null) {
    setMovedIds((prev) => new Set(prev).add(serviceId));
    startTransition(async () => {
      const res = await gqlAction(MOVE_TO_FOLDER, { serviceId, folderId });
      if (res.ok) {
        toast.success(folderId ? "Moved to folder" : "Moved out of folder");
        router.refresh();
      } else {
        toast.error(res.error);
        setMovedIds((prev) => {
          const next = new Set(prev);
          next.delete(serviceId);
          return next;
        });
      }
    });
  }

  // Move a service into a project container (or out, when projectId is null),
  // with the same optimistic hide + refresh contract as moveService.
  function moveServiceToProject(serviceId: string, projectId: string | null) {
    setMovedIds((prev) => new Set(prev).add(serviceId));
    startTransition(async () => {
      const res = await gqlAction(MOVE_SERVICE_TO_PROJECT, {
        serviceId,
        projectId,
      });
      if (res.ok) {
        toast.success(projectId ? "Moved into project" : "Moved out of project");
        router.refresh();
      } else {
        toast.error(res.error);
        setMovedIds((prev) => {
          const next = new Set(prev);
          next.delete(serviceId);
          return next;
        });
      }
    });
  }

  // The multi-selection variant: one mutation per service (no bulk endpoint),
  // fired together and settled with a single refresh.
  function moveServicesToProject(ids: string[], projectId: string | null) {
    if (ids.length === 0) return;
    setMovedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    startTransition(async () => {
      const results = await Promise.all(
        ids.map((serviceId) =>
          gqlAction(MOVE_SERVICE_TO_PROJECT, { serviceId, projectId }),
        ),
      );
      const failed = results.find((r) => !r.ok);
      if (!failed) {
        toast.success(
          `Moved ${ids.length} service${ids.length === 1 ? "" : "s"}`,
        );
        clearSelection();
      } else {
        toast.error(failed.error);
        // Revert the whole batch's optimistic hide (like the single-item move):
        // if EVERY mutation failed the refresh returns identical props, the sig
        // never changes, and un-reverted ids would stay invisible forever. Any
        // ids that DID move are re-hidden by the refresh itself.
        setMovedIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }
      // Refresh either way: a partial failure re-reveals whatever didn't move.
      router.refresh();
    });
  }

  function reorderServiceList(activeId: string, overId: string) {
    const oldIndex = order.indexOf(activeId);
    const newIndex = order.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;
    const previous = order;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    persistReorder(REORDER_SERVICES, next, () => setOrder(previous));
  }

  // Reorder a whole multi-selection together: lift every selected project out of
  // the order (keeping their relative order) and re-insert the block at the drop
  // target — so a marquee/ctrl-selected group can be repositioned in one drag.
  function reorderServiceGroup(
    activeId: string,
    overId: string,
    selIds: string[],
  ) {
    const selSet = new Set(selIds);
    if (selSet.has(overId)) return; // dropped onto a group member → no-op
    const rest = order.filter((id) => !selSet.has(id));
    let target = rest.indexOf(overId);
    if (target < 0) return;
    // Dragging downward (active was before the target) → land AFTER the target,
    // matching single-item arrayMove semantics.
    if (order.indexOf(activeId) < order.indexOf(overId)) target += 1;
    const previous = order;
    const next = [...rest.slice(0, target), ...selIds, ...rest.slice(target)];
    setOrder(next);
    persistReorder(REORDER_SERVICES, next, () => setOrder(previous));
  }

  function reorderFolderList(activeId: string, overId: string) {
    const ids = folderItems.map((f) => f.id);
    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;
    const previous = folderOrder;
    const next = arrayMove(ids, oldIndex, newIndex);
    setFolderOrder(next);
    persistReorder(REORDER_FOLDERS, next, () => setFolderOrder(previous));
  }

  function reorderProjectList(activeId: string, overId: string) {
    const ids = projectItems.map((p) => p.id);
    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;
    const previous = projectOrder;
    const next = arrayMove(ids, oldIndex, newIndex);
    setProjectOrder(next);
    persistReorder(REORDER_PROJECT_CONTAINERS, next, () =>
      setProjectOrder(previous),
    );
  }

  // Restrict each card kind to the droppables it can meaningfully land on, so
  // closestCenter never resolves a drag onto a neighbour the drop handler would
  // ignore (which makes reordering feel broken):
  //  - a project container only reorders among other projects;
  //  - a folder only reorders among other folders (folders never enter a
  //    project — ADR-0009: a project's contents are its environments' services);
  //  - a service keeps every droppable (siblings to reorder among, folders and
  //    projects to drop into, and the breadcrumb to move out a level).
  const collisionDetection = React.useCallback<CollisionDetection>(
    (args) => {
      const a = String(args.active.id);
      if (projectIdSet.has(a)) {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) =>
            projectIdSet.has(String(c.id)),
          ),
        });
      }
      if (folderIdSet.has(a)) {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) =>
            folderIdSet.has(String(c.id)),
          ),
        });
      }
      return closestCenter(args);
    },
    [folderIdSet, projectIdSet],
  );

  // Track the hovered droppable during the drag (cheap: only re-renders when the
  // target actually changes) so the dragged card can react to the folder under it.
  function onDragOver(event: DragOverEvent) {
    const next = event.over ? String(event.over.id) : null;
    setOverId((prev) => (prev === next ? prev : next));
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null); // release → everything settles immediately
    setOverId(null);
    const { active, over } = event;
    if (!over) return;
    const a = String(active.id);
    const o = String(over.id);

    const aIsFolder = folderIdSet.has(a);
    const aIsProject = projectIdSet.has(a);

    // The dragged card belongs to a multi-selection of ≥2 services → the whole
    // group moves together (reorder, into a folder/project, or out of one).
    const selServices = order.filter(
      (id) => selected.has(id) && !folderIdSet.has(id),
    );
    const groupDrag =
      !aIsFolder && !aIsProject && selected.has(a) && selServices.length >= 2;

    // Drop onto the breadcrumb zone → move OUT one level: to the open folder's
    // own parent, or out of the open project, back to the top level.
    if (o === UNGROUP_DROP_ID) {
      if (aIsProject || aIsFolder) return;
      if (openFolder) {
        const dest = openFolder.parentId ?? null;
        if (groupDrag) bulkMoveTo(dest);
        else moveService(a, dest);
      } else if (openProject) {
        // selectedServiceIds() (not the raw selection) so a stale off-screen id
        // left in `selected` by a concurrent move is never dragged along — the
        // same visibility guard every other bulk action routes through.
        if (groupDrag) moveServicesToProject(selectedServiceIds(), null);
        else moveServiceToProject(a, null);
      }
      return;
    }
    if (a === o) return;

    const oIsFolder = folderIdSet.has(o);
    const oIsProject = projectIdSet.has(o);
    if (aIsProject) {
      // Projects only reorder among themselves (collision detection already
      // restricts their targets, this is the belt to those braces).
      if (oIsProject) reorderProjectList(a, o);
    } else if (aIsFolder) {
      if (oIsFolder) reorderFolderList(a, o); // reorder among folders
      // (folder onto a service/project: ignored — folders don't nest there)
    } else if (oIsProject) {
      // Service(s) dropped onto a project container card. The group path uses
      // selectedServiceIds() — the visibility-guarded selection — not the raw
      // `selServices` (see the breadcrumb branch above).
      if (groupDrag) moveServicesToProject(selectedServiceIds(), o);
      else moveServiceToProject(a, o);
    } else if (oIsFolder) {
      // Service(s) dropped onto a folder → move the whole selection (or just the
      // one) into it.
      if (groupDrag) bulkMoveTo(o);
      else moveService(a, o);
    } else {
      // Reorder among services — the whole selected group when multi-selecting.
      if (groupDrag) reorderServiceGroup(a, o, selServices);
      else reorderServiceList(a, o);
    }
  }

  const serviceStrategy =
    view === "list" ? verticalListSortingStrategy : rectSortingStrategy;

  // The selection-aware bulk actions, fed to the floating SelectionActionBar
  // that appears whenever one or more cards are selected.
  const bulkSelection: SelectionBulk = {
    count: selectionCount,
    onSelectAll: selectAll,
    onClear: clearSelection,
    onDelete: () => setBulkDeleteOpen(true),
    onNewFolderWithSelection: () => openNewFolder(true),
    moveTargets: allFolders,
    onMoveTo: bulkMoveTo,
  };
  // The selected services in the team-wide `order`, so a group drag keeps their
  // relative order. A multi-selection drag (≥2 selected services, the dragged
  // one among them) reorders / moves the whole group together.
  const selectedServiceOrder = order.filter(
    (id) => selected.has(id) && !folderIdSet.has(id),
  );
  const activeIsSelectedMulti =
    activeId != null &&
    !folderIdSet.has(activeId) &&
    selected.has(activeId) &&
    selectedServiceOrder.length >= 2;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setOverId(null);
      }}
    >
      <>
        {/* The canvas: a relative, tall surface so there's empty space to start
            a marquee, and the coordinate space the marquee hit-tests against. */}
        <div
          ref={canvasRef}
          onPointerDown={onCanvasPointerDown}
          // select-none so sweeping a marquee across the section labels /
          // breadcrumb doesn't also start a native text selection.
          className="relative min-h-[60vh] select-none space-y-6"
        >
          {/* Imperatively positioned by the selection hook during a drag (no
              per-pointermove re-render); hidden when idle. */}
          <div
            ref={marqueeRef}
            className="pointer-events-none absolute z-20 hidden rounded-sm border border-primary bg-primary/10"
          />
          {(openFolder || openProject) && (
            <DroppableBreadcrumb
              path={folderPath}
              view={view}
              dragging={dragging && activeIsService}
            />
          )}
          {/* Projects and folders share one grid — projects first, then folders,
              on the same level. Each kind keeps its own SortableContext (renders
              no DOM) so drag-reorder stays scoped to its kind (ADR-0009). */}
          {(projectItems.length > 0 || folderItems.length > 0) && (
            <div className={gridClass(view)}>
              {projectItems.length > 0 && (
                <SortableContext
                  items={projectItems.map((p) => p.id)}
                  strategy={rectSortingStrategy}
                >
                  {projectItems.map((p) => (
                    <SortableItem
                      key={p.id}
                      id={p.id}
                      dragging={dragging}
                      dataKind="project"
                    >
                      {({ handle, dragActive, isOver }) => (
                        <ProjectContainerCard
                          project={p}
                          view={view}
                          canManage={canManageProjects}
                          dragHandle={handle}
                          dragActive={dragActive}
                          dropActive={isOver && activeIsService}
                        />
                      )}
                    </SortableItem>
                  ))}
                </SortableContext>
              )}
              {folderItems.length > 0 && (
                <SortableContext
                  items={folderItems.map((f) => f.id)}
                  strategy={rectSortingStrategy}
                >
                  {folderItems.map((f) => (
                    <SortableItem
                      key={f.id}
                      id={f.id}
                      dragging={dragging}
                      selected={selected.has(f.id)}
                      dataKind="folder"
                      onSelect={(e) => onItemClick(f.id, e)}
                    >
                      {({ handle, dragActive, isOver }) => (
                        <FolderCard
                          folder={f}
                          view={view}
                          isAdminOverride={canManageAllFolders}
                          folders={allFolders}
                          dragHandle={handle}
                          dragActive={dragActive}
                          dropActive={isOver && activeIsService}
                        />
                      )}
                    </SortableItem>
                  ))}
                </SortableContext>
              )}
            </div>
          )}
          {/* Ungrouped services always get their own separate grid, same size. */}
          <SortableContext
            items={items.map((p) => p.id)}
            strategy={serviceStrategy}
          >
            <div className={gridClass(view)}>
              {items.map((p) => (
                <SortableItem
                  key={p.id}
                  id={p.id}
                  dragging={dragging}
                  scaleOut={draggedOverFolder}
                  selected={selected.has(p.id)}
                  // During a group drag, dim every selected project (not just the
                  // lifted one) so the whole moving group reads as picked up.
                  groupDragging={activeIsSelectedMulti}
                  dataKind="service"
                  onSelect={(e) => onItemClick(p.id, e)}
                >
                  {({ handle, dragActive }) => (
                    <ServiceCard
                      project={p}
                      view={view}
                      dragHandle={handle}
                      dragActive={dragActive}
                      folders={allFolders}
                      canManageFolders={canManageAllFolders}
                      environments={
                        canManageProjects ? environments : undefined
                      }
                    />
                  )}
                </SortableItem>
              ))}
            </div>
          </SortableContext>
        </div>
        <SelectionActionBar
          selection={bulkSelection}
          canCreateFolder={canCreateFolder}
          canManageAllFolders={canManageAllFolders}
        />
      </>

      {/* The lifted card that follows the cursor (macOS/Notion feel). Rendered in
          a portal above everything, so it is never clipped by the grid's
          overflow/stacking. The original card stays as a dimmed placeholder. */}
      <DragOverlay dropAnimation={DRAG_DROP_ANIMATION}>
        {activeProject ? (
          <div className="pointer-events-none rotate-[1.5deg] cursor-grabbing rounded-xl shadow-2xl ring-1 ring-border/60">
            <ProjectContainerCard
              project={activeProject}
              view={view}
              canManage={canManageProjects}
            />
          </div>
        ) : activeFolder ? (
          <div className="pointer-events-none rotate-[1.5deg] cursor-grabbing rounded-xl shadow-2xl ring-1 ring-border/60">
            <FolderCard
              folder={activeFolder}
              view={view}
              isAdminOverride={canManageAllFolders}
              folders={allFolders}
            />
          </div>
        ) : activeService ? (
          <div
            className={cn(
              "pointer-events-none relative rotate-[1.5deg] cursor-grabbing rounded-xl shadow-2xl ring-1 ring-border/60 transition-transform duration-200 ease-out",
              // Hovering a folder or project → the floating clone shrinks as a
              // preview of being absorbed into it.
              draggedOverFolder && "scale-50 opacity-80",
            )}
          >
            <ServiceCard
              project={activeService}
              view={view}
              folders={allFolders}
              canManageFolders={canManageAllFolders}
            />
            {/* Dragging a multi-selection → a badge with how many move together. */}
            {activeIsSelectedMulti && (
              <span className="absolute -right-2 -top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground shadow-md ring-2 ring-background">
                {selectionCount}
              </span>
            )}
          </div>
        ) : null}
      </DragOverlay>

      <CreateFolderDialog
        open={createFolderOpen}
        onOpenChange={(o) => {
          setCreateFolderOpen(o);
          if (!o) setFolderTakesSelection(false);
        }}
        parentId={openFolder?.id ?? null}
        onCreated={folderTakesSelection ? moveSelectionInto : undefined}
        description={
          folderTakesSelection
            ? `Create a folder and move the ${selectedServiceIds().length} selected project(s) into it.`
            : undefined
        }
      />
      <ConfirmAction
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${selectionCount} item${selectionCount === 1 ? "" : "s"}?`}
        description="Selected services are permanently deleted (with their deployments, domains and env vars). Selected folders are removed — their services move back to the top level. This can't be undone."
        confirmLabel="Delete selection"
        successMessage="Selection deleted"
        onConfirm={bulkDelete}
      />
    </DndContext>
  );
}

/** Nested-folder breadcrumb that doubles as a "move out one level" drop target. */
function DroppableBreadcrumb({
  path,
  view,
  dragging,
}: {
  path: FolderRef[];
  view: "grid" | "list";
  dragging: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: UNGROUP_DROP_ID });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md px-1 py-1 transition-colors",
        dragging && "ring-1 ring-dashed ring-border",
        isOver && "bg-primary/10 ring-1 ring-primary/40",
      )}
    >
      <FolderTrail path={path} view={view} />
      {dragging && (
        <span className="ml-1 text-xs text-muted-foreground">
          {isOver ? "Release to move out a level" : "drop here to move out"}
        </span>
      )}
    </div>
  );
}

/**
 * Sortable wrapper shared by project + folder cards. Provides the dnd-kit
 * sortable node, a keyboard drag handle, the drag-bound jiggle, and swallows the
 * click dnd-kit emits on the dragged card after a drop (so a drag never
 * navigates). Children render with the handle, the link-inert flag, and whether
 * a draggable is currently over this node (for the folder drop highlight).
 */
function SortableItem({
  id,
  dragging,
  scaleOut = false,
  selected = false,
  groupDragging = false,
  dataKind,
  onSelect,
  children,
}: {
  id: string;
  dragging: boolean;
  /** When this item is the one being dragged, shrink it to nothing (smoothly) —
   *  used to preview a service being absorbed into the folder it hovers. */
  scaleOut?: boolean;
  /** Whether this card is part of the current multi-selection (shows a ring). */
  selected?: boolean;
  /** A multi-selection group drag is in flight → dim every selected card (not
   *  only the lifted one) so the whole moving group reads as picked up. */
  groupDragging?: boolean;
  /** "service" | "folder" — surfaced as data-card-kind for marquee hit-testing. */
  dataKind?: string;
  /** Modifier-click (ctrl/cmd/shift) selection handler. */
  onSelect?: (e: React.MouseEvent) => void;
  children: (opts: {
    handle: React.ReactNode;
    dragActive: boolean;
    isOver: boolean;
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
    isOver,
    index,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Split listeners by input: pointer activators (Mouse/Touch) drive the whole-
  // card drag from the wrapper; the keyboard activator lives on the handle so
  // the card keeps clean link semantics rather than becoming a focusable button.
  const { onKeyDown: keyboardListener, ...pointerDragListeners } =
    listeners ?? {};
  // Drop the draggable's role="button" (and its role-only ARIA companions) from
  // the wrapper: it also hosts the ⋯ menu button, and a button must not nest one.
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    role: _omitRole,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    "aria-roledescription": _omitRoleDesc,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted via rest
    "aria-pressed": _omitPressed,
    ...wrapperAttributes
  } = attributes;

  // Belt-and-suspenders for the trailing click after a drag: dnd-kit already
  // stops that click at the document level, but if it slips through we swallow
  // it so a drag never navigates. CRITICAL: the latch must SELF-CLEAR on drag
  // end — not only inside onClickCapture — because when dnd-kit eats the click
  // our handler never runs, and a left-true latch would then eat the user's NEXT
  // genuine click (or modifier-select) on this same (never-remounted) card.
  const draggedRef = React.useRef(false);
  React.useEffect(() => {
    if (isDragging) {
      draggedRef.current = true;
      return;
    }
    // Drag ended: keep the latch just long enough to cover the trailing click,
    // then clear it so later real clicks are never mistaken for it.
    const t = window.setTimeout(() => {
      draggedRef.current = false;
    }, 300);
    return () => window.clearTimeout(t);
  }, [isDragging]);

  function onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
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
    // 2) Modifier-click selects this card instead of navigating (spare the ⋯).
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && onSelect && !onControls) {
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
      data-card-id={id}
      data-card-kind={dataKind}
      onClickCapture={onClickCapture}
      className={cn(
        // Suppress the native long-press callout / text selection so a touch
        // drag isn't preempted by the browser's own link/selection UI.
        "touch-manipulation select-none rounded-xl [-webkit-touch-callout:none]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        // Multi-selection highlight (marquee / ctrl+click).
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        // Only the stacking lives on the outer node — the translate dnd-kit
        // writes here must stay instant so the card tracks the pointer. The lift
        // and the scale animation go on the inner wrapper below.
        isDragging && "relative z-10",
      )}
      {...wrapperAttributes}
      {...pointerDragListeners}
    >
      {/* Inner wrapper carries the jiggle (non-active cards). The card actually
          being dragged is rendered by the floating <DragOverlay> clone (which
          tracks the cursor with the lift); here the original is left as a dimmed
          placeholder that holds — and, when hovering a folder, collapses — its
          slot in the grid flow. */}
      <div
        className={cn(
          "rounded-xl",
          dragging && !isDragging && "animate-jiggle",
          isDragging && "opacity-40 transition-transform duration-200 ease-out",
          // A selected sibling during a group drag also dims (held in place),
          // so the whole moving group reads as picked up — not just the lifted one.
          !isDragging &&
            groupDragging &&
            selected &&
            "opacity-40 transition-opacity duration-150",
          // Hovering a folder → the placeholder slot collapses to nothing as the
          // floating clone is absorbed; it grows back the moment it leaves.
          isDragging && scaleOut && "scale-0",
        )}
        style={
          dragging && !isDragging
            ? { animationDelay: `${-((index ?? 0) % 6) * 40}ms` }
            : undefined
        }
      >
        {children({ handle, dragActive: dragging, isOver })}
      </div>
    </div>
  );
}
