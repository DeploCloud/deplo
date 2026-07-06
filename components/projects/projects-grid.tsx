"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronLeft,
  GripVertical,
  Plus,
  Rocket,
  FolderPlus,
  Database,
  FolderInput,
  MousePointerSquareDashed,
  RotateCw,
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
import { ProjectCard } from "./project-card";
import { FolderCard, folderHref, type FolderCardData } from "./folder-card";
import { CreateFolderDialog } from "./create-folder-dialog";
import { useOverviewSelection } from "./use-overview-selection";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { ProjectSummary } from "@/lib/data/projects";

const REORDER_PROJECTS = `mutation($ids: [ID!]!) { reorderProjects(projectIds: $ids) }`;
const REORDER_FOLDERS = `mutation($ids: [ID!]!) { reorderFolders(folderIds: $ids) }`;
const MOVE_TO_FOLDER = `mutation($projectId: ID!, $folderId: ID) { moveProjectToFolder(projectId: $projectId, folderId: $folderId) }`;
const DELETE_FOLDER = `mutation($id: ID!) { deleteFolder(id: $id) }`;
// Bulk variants: each is ONE server round-trip + ONE store write for the whole
// selection (instead of N fanned-out per-id mutations).
const BULK_MOVE = `mutation($ids: [ID!]!, $folderId: ID) { moveProjectsToFolder(projectIds: $ids, folderId: $folderId) }`;
const BULK_DELETE = `mutation($ids: [ID!]!) { deleteProjects(ids: $ids) }`;

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

function gridClass(view: "grid" | "list"): string {
  return view === "list" ? "flex flex-col gap-3" : "grid gap-4 sm:grid-cols-2";
}

function allProjectsHref(view: "grid" | "list"): string {
  return view === "list" ? "/?view=list" : "/";
}

/** The "New ▸" submenu shared by both grids' empty-space context menu. Project
 *  and Database are links; Folder opens the create dialog via `onNewFolder`. */
function NewMenuItems({
  canCreateFolder,
  onNewFolder,
}: {
  canCreateFolder: boolean;
  onNewFolder: () => void;
}) {
  return (
    <ContextMenuSub>
      <SimpleTooltip content="Create something new in this team" side="right">
        <ContextMenuSubTrigger>
          <Plus className="size-4" />
          New
        </ContextMenuSubTrigger>
      </SimpleTooltip>
      <ContextMenuSubContent>
        <SimpleTooltip
          content="Import a Git repository or start from a template"
          side="right"
        >
          <ContextMenuItem asChild>
            <Link href="/new" className="cursor-pointer">
              <Rocket className="size-4" />
              Project
            </Link>
          </ContextMenuItem>
        </SimpleTooltip>
        {canCreateFolder && (
          <SimpleTooltip
            content="Create an empty folder to group projects"
            side="right"
          >
            <ContextMenuItem onSelect={onNewFolder}>
              <FolderPlus className="size-4" />
              Folder
            </ContextMenuItem>
          </SimpleTooltip>
        )}
        <SimpleTooltip content="Provision a managed database" side="right">
          <ContextMenuItem asChild>
            <Link href="/storage?new=database" className="cursor-pointer">
              <Database className="size-4" />
              Database
            </Link>
          </ContextMenuItem>
        </SimpleTooltip>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
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
 * The selection-aware BULK actions, rendered with the ContextMenu primitives so
 * they can appear BOTH on the empty-canvas menu AND — replacing a card's own
 * single-item menu — when right-clicking a selected card. "New folder with
 * selection" is a CREATE action (gated on `canCreateFolder`); the team-wide
 * move/delete are gated on `canManageAllFolders`. Select all + Clear are always
 * shown. This is the one place the bulk actions are defined.
 */
function BulkActionsMenuItems({
  selection,
  canCreateFolder,
  canManageAllFolders,
}: {
  selection: SelectionBulk;
  canCreateFolder: boolean;
  canManageAllFolders: boolean;
}) {
  return (
    <>
      <ContextMenuLabel>{selection.count} selected</ContextMenuLabel>
      {canCreateFolder && (
        <SimpleTooltip
          content="Create a folder and move the selected projects into it"
          side="right"
        >
          <ContextMenuItem onSelect={selection.onNewFolderWithSelection}>
            <FolderPlus className="size-4" />
            New folder with selection
          </ContextMenuItem>
        </SimpleTooltip>
      )}
      {canManageAllFolders && (
        <>
          <ContextMenuSub>
            <SimpleTooltip
              content="Move the selected projects into a folder"
              side="right"
            >
              <ContextMenuSubTrigger>
                <FolderInput className="size-4" />
                Move selection to
              </ContextMenuSubTrigger>
            </SimpleTooltip>
            <ContextMenuSubContent className="max-h-72 overflow-y-auto">
              <SimpleTooltip
                content="Move to the top level (ungrouped)"
                side="right"
              >
                <ContextMenuItem onSelect={() => selection.onMoveTo(null)}>
                  Ungrouped
                </ContextMenuItem>
              </SimpleTooltip>
              {selection.moveTargets.length > 0 && <ContextMenuSeparator />}
              {selection.moveTargets.map((f) => (
                <SimpleTooltip
                  key={f.id}
                  content={`Move into ${f.name}`}
                  side="right"
                >
                  <ContextMenuItem onSelect={() => selection.onMoveTo(f.id)}>
                    {f.name}
                  </ContextMenuItem>
                </SimpleTooltip>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <SimpleTooltip
            content="Delete the selected projects and folders"
            side="right"
          >
            <ContextMenuItem
              variant="destructive"
              onSelect={selection.onDelete}
            >
              <Trash2 className="size-4" />
              Delete selection
              <ContextMenuShortcut>⌫</ContextMenuShortcut>
            </ContextMenuItem>
          </SimpleTooltip>
        </>
      )}
      <ContextMenuSeparator />
      <SimpleTooltip
        content="Select every project and folder on this page"
        side="right"
      >
        <ContextMenuItem onSelect={selection.onSelectAll}>
          <MousePointerSquareDashed className="size-4" />
          Select all
          <ContextMenuShortcut>⌘A</ContextMenuShortcut>
        </ContextMenuItem>
      </SimpleTooltip>
      <SimpleTooltip content="Clear the current selection" side="right">
        <ContextMenuItem onSelect={selection.onClear}>
          <X className="size-4" />
          Clear selection
          <ContextMenuShortcut>Esc</ContextMenuShortcut>
        </ContextMenuItem>
      </SimpleTooltip>
    </>
  );
}

/**
 * Right-click menu for the EMPTY canvas: "New ▸", Select all, Refresh, and —
 * when a selection exists — the selection-aware bulk actions. Its single child
 * becomes the right-click trigger (the canvas). Per-card right-clicks are
 * handled by each card's own context menu (which stops propagation), so exactly
 * one menu ever opens.
 */
function OverviewContextMenu({
  canCreateFolder,
  canManageAllFolders,
  onNewFolder,
  onRefresh,
  selection,
  children,
}: {
  canCreateFolder: boolean;
  canManageAllFolders: boolean;
  onNewFolder: () => void;
  onRefresh: () => void;
  selection?: SelectionBulk;
  children: React.ReactNode;
}) {
  const hasSelection = (selection?.count ?? 0) > 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <NewMenuItems
          canCreateFolder={canCreateFolder}
          onNewFolder={onNewFolder}
        />
        {selection && !hasSelection && (
          <SimpleTooltip
            content="Select every project and folder on this page"
            side="right"
          >
            <ContextMenuItem onSelect={selection.onSelectAll}>
              <MousePointerSquareDashed className="size-4" />
              Select all
              <ContextMenuShortcut>⌘A</ContextMenuShortcut>
            </ContextMenuItem>
          </SimpleTooltip>
        )}
        {selection && hasSelection && (
          <>
            <ContextMenuSeparator />
            <BulkActionsMenuItems
              selection={selection}
              canCreateFolder={canCreateFolder}
              canManageAllFolders={canManageAllFolders}
            />
          </>
        )}
        <ContextMenuSeparator />
        <SimpleTooltip content="Reload the latest data" side="right">
          <ContextMenuItem onSelect={onRefresh}>
            <RotateCw className="size-4" />
            Refresh
          </ContextMenuItem>
        </SimpleTooltip>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export interface ProjectsGridProps {
  /**
   * The projects to DISPLAY: a folder's contents (when one is open), the
   * ungrouped top level, or flat search results. The card objects always come
   * from the latest server props, so per-card fields stay fresh.
   */
  projects: ProjectSummary[];
  /**
   * The FULL team project order (all folders), ids only. A within-group reorder
   * is persisted against this so the other groups' relative order is preserved.
   */
  allProjectIds: string[];
  /** Folder cards to show before the projects (top level only; [] otherwise). */
  folders: FolderCardData[];
  /** Every team folder (id + name) for the cards' "Move to folder" menu. */
  allFolders: FolderRef[];
  /** The folder currently open (with its parent, for "move out"), or null at the
   *  top level. */
  openFolder: (FolderRef & { parentId: string | null }) | null;
  /** Breadcrumb trail from the top level down to the open folder (inclusive). */
  folderPath: FolderRef[];
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
export function ProjectsGrid(props: ProjectsGridProps) {
  if (!props.canReorder) return <StaticGrid {...props} />;
  return <SortableGrid {...props} />;
}

/* ------------------------------------------------------------------ */
/* Static (no reorder): search results, or no permission              */
/* ------------------------------------------------------------------ */

function StaticGrid({
  projects,
  folders,
  allFolders,
  openFolder,
  folderPath,
  view,
  canCreateFolder,
  canManageAllFolders,
}: ProjectsGridProps) {
  const router = useRouter();
  const [createFolderOpen, setCreateFolderOpen] = React.useState(false);
  return (
    <>
      <OverviewContextMenu
        canCreateFolder={canCreateFolder}
        canManageAllFolders={canManageAllFolders}
        onNewFolder={() => setCreateFolderOpen(true)}
        onRefresh={() => router.refresh()}
      >
        <div className="relative min-h-[40vh] space-y-6">
          {openFolder && <FolderTrail path={folderPath} view={view} />}
          {folders.length > 0 && (
            <section className="space-y-3">
              <div className={gridClass(view)}>
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
            </section>
          )}
          {projects.length > 0 && (
            <section className="space-y-3">
              <div className={gridClass(view)}>
                {projects.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    view={view}
                    folders={allFolders}
                    canManageFolders={canManageAllFolders}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </OverviewContextMenu>
      {canCreateFolder && (
        <CreateFolderDialog
          open={createFolderOpen}
          onOpenChange={setCreateFolderOpen}
          parentId={openFolder?.id ?? null}
        />
      )}
    </>
  );
}

/**
 * The nested-folder breadcrumb: "All projects / A / B / Current". Every ancestor
 * segment links to that level; the last (current) folder is plain text. Folders
 * nest, so the trail can be several levels deep.
 */
function FolderTrail({
  path,
  view,
}: {
  path: FolderRef[];
  view: "grid" | "list";
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <Link
        href={allProjectsHref(view)}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All projects
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
                href={folderHref(seg.id, view)}
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
  projects,
  allProjectIds,
  folders,
  allFolders,
  openFolder,
  folderPath,
  view,
  canCreateFolder,
  canManageAllFolders,
}: ProjectsGridProps) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();

  // Local optimistic order for snappy moves. The order arrays are the sole
  // source of arrangement; the card objects always come from props (so status
  // etc. stay fresh). The parent keys this component on the *membership* of the
  // grid (the sets of project + folder ids), so a reorder/move never remounts
  // it — letting the drag survive a drop — while add/remove re-seeds.
  const [order, setOrder] = React.useState<string[]>(() => allProjectIds);
  const [folderOrder, setFolderOrder] = React.useState<string[]>(() =>
    folders.map((f) => f.id),
  );
  // Projects optimistically hidden from the current view while a move-to-folder
  // round-trips. Cleared whenever the visible projection actually changes (the
  // refresh landing, or navigating in/out of a folder) — see the effect below.
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
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );
  const folderById = React.useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );

  // Clear optimistic move-hides whenever the visible projection actually changes
  // — the move's refresh landing, or navigating in/out of a folder. Done in
  // render via the previous-value pattern (not an effect) so it never triggers a
  // cascading render; a pending move keeps its hide until its own refresh lands.
  const sig = projects.map((p) => `${p.id}:${p.folderId ?? ""}`).join(",");
  const [prevSig, setPrevSig] = React.useState(sig);
  if (sig !== prevSig) {
    setPrevSig(sig);
    setMovedIds(new Set());
  }

  // The folders to render, in local order, dropping stale ids and appending any
  // the local order hasn't seen yet (a freshly created folder).
  const folderItems = React.useMemo(() => {
    const ordered = folderOrder
      .map((id) => folderById.get(id))
      .filter((f): f is FolderCardData => f != null);
    const known = new Set(folderOrder);
    return [...ordered, ...folders.filter((f) => !known.has(f.id))];
  }, [folderOrder, folderById, folders]);

  const folderIdSet = React.useMemo(
    () => new Set(folderItems.map((f) => f.id)),
    [folderItems],
  );

  // The visible projects, in the full local order, filtered to the displayed
  // group (everything in `byId`) minus anything optimistically moved away.
  const items = React.useMemo(() => {
    const ordered = order
      .map((id) => byId.get(id))
      .filter(
        (p): p is ProjectSummary => p != null && !movedIds.has(p.id),
      );
    const known = new Set(order);
    return [
      ...ordered,
      ...projects.filter((p) => !known.has(p.id) && !movedIds.has(p.id)),
    ];
  }, [order, byId, projects, movedIds]);

  const activeIsProject = activeId !== null && !folderIdSet.has(activeId);
  // The actual card behind the floating drag clone (the lifted card that tracks
  // the cursor). A folder never absorbs into another, so only a project clone
  // shrinks when hovering a folder.
  const activeFolder = activeId ? folderById.get(activeId) ?? null : null;
  const activeProject =
    activeId && !activeFolder ? byId.get(activeId) ?? null : null;
  // A dragged project is hovering a folder → its card shrinks (scale-0) as a
  // preview of being dropped in; it grows back the moment it leaves.
  const draggedOverFolder =
    activeIsProject && overId != null && folderIdSet.has(overId);

  /* ---- Multi-selection (marquee + ctrl/shift-click) + bulk actions ------- */
  // Selectable ids in display order: folders first, then the visible projects.
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

  const selectedProjectIds = () =>
    effectiveSelected.filter((id) => !folderIdSet.has(id));
  const selectedFolderIds = () =>
    effectiveSelected.filter((id) => folderIdSet.has(id));

  function bulkMoveTo(folderId: string | null) {
    const ids = selectedProjectIds();
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
  // projects into the folder the dialog just created (one bulk call).
  async function moveSelectionInto(folderId: string) {
    const ids = selectedProjectIds();
    if (ids.length) await gqlAction(BULK_MOVE, { ids, folderId });
    clearSelection();
  }

  async function bulkDelete() {
    const projectIds = selectedProjectIds();
    const folderIds = selectedFolderIds();
    // Projects go through ONE bulk mutation (one server write, bounded-
    // concurrency teardown); folders (usually few) delete per id.
    const results = await Promise.all([
      ...(projectIds.length ? [gqlAction(BULK_DELETE, { ids: projectIds })] : []),
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

  function moveProject(projectId: string, folderId: string | null) {
    setMovedIds((prev) => new Set(prev).add(projectId));
    startTransition(async () => {
      const res = await gqlAction(MOVE_TO_FOLDER, { projectId, folderId });
      if (res.ok) {
        toast.success(folderId ? "Moved to folder" : "Moved out of folder");
        router.refresh();
      } else {
        toast.error(res.error);
        setMovedIds((prev) => {
          const next = new Set(prev);
          next.delete(projectId);
          return next;
        });
      }
    });
  }

  function reorderProjectList(activeId: string, overId: string) {
    const oldIndex = order.indexOf(activeId);
    const newIndex = order.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;
    const previous = order;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    persistReorder(REORDER_PROJECTS, next, () => setOrder(previous));
  }

  // Reorder a whole multi-selection together: lift every selected project out of
  // the order (keeping their relative order) and re-insert the block at the drop
  // target — so a marquee/ctrl-selected group can be repositioned in one drag.
  function reorderProjectGroup(
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
    persistReorder(REORDER_PROJECTS, next, () => setOrder(previous));
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

  // A folder being dragged only ever targets OTHER folders (reorder), never a
  // project. Folders and ungrouped projects share one grid flow, so a plain
  // closestCenter can resolve a folder drag onto an adjacent project card —
  // which the drop handler then ignores, making folder reorder feel broken.
  // Restricting a folder's candidate droppables to folders makes it reliable.
  // A project keeps every droppable (sibling projects to reorder among, folders
  // to drop into, and the breadcrumb to leave a folder).
  const collisionDetection = React.useCallback<CollisionDetection>(
    (args) => {
      if (folderIdSet.has(String(args.active.id))) {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) =>
            folderIdSet.has(String(c.id)),
          ),
        });
      }
      return closestCenter(args);
    },
    [folderIdSet],
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

    // The dragged card belongs to a multi-selection of ≥2 projects → the whole
    // group moves together (reorder, into a folder, or out of one).
    const selProjects = order.filter(
      (id) => selected.has(id) && !folderIdSet.has(id),
    );
    const groupDrag =
      !folderIdSet.has(a) && selected.has(a) && selProjects.length >= 2;

    // Drop onto the breadcrumb zone → move OUT one level, to the open folder's
    // own parent (or the top level when it has none).
    if (o === UNGROUP_DROP_ID) {
      if (!folderIdSet.has(a)) {
        const dest = openFolder?.parentId ?? null;
        if (groupDrag) bulkMoveTo(dest);
        else moveProject(a, dest);
      }
      return;
    }
    if (a === o) return;

    const aIsFolder = folderIdSet.has(a);
    const oIsFolder = folderIdSet.has(o);
    if (aIsFolder && oIsFolder) {
      reorderFolderList(a, o); // reorder folders among themselves
    } else if (!aIsFolder && oIsFolder) {
      // Project(s) dropped onto a folder → move the whole selection (or just the
      // one) into it.
      if (groupDrag) bulkMoveTo(o);
      else moveProject(a, o);
    } else if (!aIsFolder && !oIsFolder) {
      // Reorder among projects — the whole selected group when multi-selecting.
      if (groupDrag) reorderProjectGroup(a, o, selProjects);
      else reorderProjectList(a, o);
    }
    // (folder dropped onto a project: ignored — folders can't nest in projects)
  }

  const projectStrategy =
    view === "list" ? verticalListSortingStrategy : rectSortingStrategy;

  // The selection-aware bulk actions, defined once and reused by the empty-canvas
  // menu AND (via `bulkMenuNode`) the right-click menu of every selected card.
  const bulkSelection: SelectionBulk = {
    count: selectionCount,
    onSelectAll: selectAll,
    onClear: clearSelection,
    onDelete: () => setBulkDeleteOpen(true),
    onNewFolderWithSelection: () => openNewFolder(true),
    moveTargets: allFolders,
    onMoveTo: bulkMoveTo,
  };
  // Shown in place of a card's own menu while it is part of a multi-selection.
  const bulkMenuNode = (
    <BulkActionsMenuItems
      selection={bulkSelection}
      canCreateFolder={canCreateFolder}
      canManageAllFolders={canManageAllFolders}
    />
  );
  // The selected projects in the team-wide `order`, so a group drag keeps their
  // relative order. A multi-selection drag (≥2 selected projects, the dragged
  // one among them) reorders / moves the whole group together.
  const selectedProjectOrder = order.filter(
    (id) => selected.has(id) && !folderIdSet.has(id),
  );
  const activeIsSelectedMulti =
    activeId != null &&
    !folderIdSet.has(activeId) &&
    selected.has(activeId) &&
    selectedProjectOrder.length >= 2;
  // Whether right-clicking a given card should show the BULK menu instead of its
  // own: only for a real multi-selection of which the card is a member. Gated on
  // the super-user flag since the bulk menu's headline actions are team-wide.
  const showBulkMenuFor = (id: string) =>
    canManageAllFolders && selectionCount >= 2 && selected.has(id);

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
      <OverviewContextMenu
        canCreateFolder={canCreateFolder}
        canManageAllFolders={canManageAllFolders}
        onNewFolder={() => openNewFolder(false)}
        onRefresh={() => router.refresh()}
        selection={bulkSelection}
      >
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
          {openFolder && (
            <DroppableBreadcrumb
              path={folderPath}
              view={view}
              dragging={dragging && activeIsProject}
            />
          )}
          {/* Folders get their own section, above and separate from the
              folder-less projects — never interleaved at the same level. */}
          {folderItems.length > 0 && (
            <section className="space-y-3">
              <SortableContext
                items={folderItems.map((f) => f.id)}
                strategy={rectSortingStrategy}
              >
                <div className={gridClass(view)}>
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
                          dropActive={isOver && activeIsProject}
                          contextMenuOverride={
                            showBulkMenuFor(f.id) ? bulkMenuNode : undefined
                          }
                        />
                      )}
                    </SortableItem>
                  ))}
                </div>
              </SortableContext>
            </section>
          )}
          <section className="space-y-3">
            <SortableContext
              items={items.map((p) => p.id)}
              strategy={projectStrategy}
            >
              <div className={gridClass(view)}>
                {items.map((p) => (
                  <SortableItem
                    key={p.id}
                    id={p.id}
                    dragging={dragging}
                    scaleOut={draggedOverFolder}
                    selected={selected.has(p.id)}
                    // During a group drag, dim every selected project (not just
                    // the lifted one) so the whole moving group reads as picked up.
                    groupDragging={activeIsSelectedMulti}
                    dataKind="project"
                    onSelect={(e) => onItemClick(p.id, e)}
                  >
                    {({ handle, dragActive }) => (
                      <ProjectCard
                        project={p}
                        view={view}
                        dragHandle={handle}
                        dragActive={dragActive}
                        folders={allFolders}
                        canManageFolders={canManageAllFolders}
                        contextMenuOverride={
                          showBulkMenuFor(p.id) ? bulkMenuNode : undefined
                        }
                      />
                    )}
                  </SortableItem>
                ))}
              </div>
            </SortableContext>
          </section>
        </div>
      </OverviewContextMenu>

      {/* The lifted card that follows the cursor (macOS/Notion feel). Rendered in
          a portal above everything, so it is never clipped by the grid's
          overflow/stacking. The original card stays as a dimmed placeholder. */}
      <DragOverlay dropAnimation={DRAG_DROP_ANIMATION}>
        {activeFolder ? (
          <div className="pointer-events-none rotate-[1.5deg] cursor-grabbing rounded-xl shadow-2xl ring-1 ring-border/60">
            <FolderCard
              folder={activeFolder}
              view={view}
              isAdminOverride={canManageAllFolders}
              folders={allFolders}
            />
          </div>
        ) : activeProject ? (
          <div
            className={cn(
              "pointer-events-none relative rotate-[1.5deg] cursor-grabbing rounded-xl shadow-2xl ring-1 ring-border/60 transition-transform duration-200 ease-out",
              // Hovering a folder → the floating clone shrinks as a preview of
              // being absorbed into it.
              draggedOverFolder && "scale-50 opacity-80",
            )}
          >
            <ProjectCard
              project={activeProject}
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
            ? `Create a folder and move the ${selectedProjectIds().length} selected project(s) into it.`
            : undefined
        }
      />
      <ConfirmAction
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${selectionCount} item${selectionCount === 1 ? "" : "s"}?`}
        description="Selected projects are permanently deleted (with their deployments, domains and env vars). Selected folders are removed — their projects move back to the top level. This can't be undone."
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
   *  used to preview a project being absorbed into the folder it hovers. */
  scaleOut?: boolean;
  /** Whether this card is part of the current multi-selection (shows a ring). */
  selected?: boolean;
  /** A multi-selection group drag is in flight → dim every selected card (not
   *  only the lifted one) so the whole moving group reads as picked up. */
  groupDragging?: boolean;
  /** "project" | "folder" — surfaced as data-card-kind for marquee hit-testing. */
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
