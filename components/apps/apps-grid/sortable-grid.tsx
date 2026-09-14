"use client";

import * as React from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
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
  rectSortingStrategy,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { AppCard } from "../app-card";
import { FolderCard } from "../folder-card";
import { ProjectContainerCard } from "../project-container-card";
import { CreateFolderDialog } from "../create-folder-dialog";
import { useCardSelection } from "@/components/shared/use-card-selection";
import { MARQUEE_BOX } from "@/components/shared/card-selection";
import { DragStack } from "@/components/shared/drag-stack";
import { cn } from "@/lib/utils";
import { gridClass, type GridProps } from "./grid-contract";
import { DroppableBreadcrumb, UNGROUP_DROP_ID } from "./folder-trail";
import { SortableItem } from "./sortable-item";
import { SelectionActionBar, type SelectionBulk } from "./selection-action-bar";
import { BulkDeleteConfirm } from "./bulk-delete-confirm";
import { useGridArrangement } from "./grid-arrangement";
import { useGridMutations } from "./grid-mutations";

// The lifted clone eases back into the settled slot while the placeholder (held
// at opacity-40) cross-fades back in.
const DRAG_DROP_ANIMATION: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

// SortableGrid is the grid with drag-to-reorder and drag-into-folder.
export function SortableGrid({
  services,
  allAppIds,
  folders,
  projects,
  allFolders,
  openFolder,
  openProject,
  folderPath,
  view,
  canReorder,
  canMoveApps,
  canCreateFolder,
  canManageAllFolders,
  canManageProjects,
  environments,
  liveStates,
  onDeleted,
  onRestored,
}: GridProps) {
  const arrangement = useGridArrangement({
    services,
    allAppIds,
    folders,
    projects,
  });
  const {
    byId,
    folderById,
    projectById,
    items,
    folderItems,
    folderIdSet,
    projectItems,
    projectIdSet,
    hideMoved,
    revealMoved,
  } = arrangement;

  // The id being dragged (null when idle). Drives the drag-bound jiggle and the
  // folder drop-target highlight; cleared on release so nothing lingers.
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const dragging = activeId !== null;
  // The droppable the pointer is currently over, used to shrink the dragged card
  // into a folder it's hovering.
  const [overId, setOverId] = React.useState<string | null>(null);

  const activeIsFolder = activeId !== null && folderIdSet.has(activeId);
  const activeIsProject = activeId !== null && projectIdSet.has(activeId);
  const activeIsApp = activeId !== null && !activeIsFolder && !activeIsProject;
  // The actual card behind the floating drag clone.
  const activeFolder = activeId ? (folderById.get(activeId) ?? null) : null;
  const activeProject = activeId ? (projectById.get(activeId) ?? null) : null;
  const activeApp = activeIsApp ? (byId.get(activeId!) ?? null) : null;
  // A dragged app hovering a container it can be dropped INTO shrinks (scale-0)
  // as a preview of being absorbed; it grows back the moment it leaves.
  const draggedOverFolder =
    activeIsApp &&
    overId != null &&
    (folderIdSet.has(overId) || projectIdSet.has(overId));

  // Rows a migration is still writing: their cards are inert, and here they are
  // taken out of drag and selection too - selection is what feeds every bulk
  // action, so leaving them in is a delete the card's own menu already refuses.
  const lockedIds = React.useMemo(
    () =>
      new Set([
        ...projectItems.filter((p) => p.migrationRunId).map((p) => p.id),
        ...items.filter((p) => p.migrationRunId).map((p) => p.id),
      ]),
    [projectItems, items],
  );

  // Selectable ids in DISPLAY order - projects, then folders, then the visible
  // apps, so a shift-click range spans the grid exactly as it reads on screen.
  const selectableIds = React.useMemo(
    () =>
      [
        ...projectItems.map((p) => p.id),
        ...folderItems.map((f) => f.id),
        ...items.map((p) => p.id),
      ].filter((id) => !lockedIds.has(id)),
    [projectItems, folderItems, items, lockedIds],
  );
  const {
    selected,
    marqueeRef,
    canvasRef,
    onItemClick,
    clear: clearSelection,
    selectAll,
  } = useCardSelection(selectableIds);

  // Only ever count / act on selected ids that are STILL on screen, in display order.
  const effectiveSelected = React.useMemo(
    () => selectableIds.filter((id) => selected.has(id)),
    [selectableIds, selected],
  );
  const selectionCount = effectiveSelected.length;

  const [createFolderOpen, setCreateFolderOpen] = React.useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [bulkDeleteApps, setBulkDeleteApps] = React.useState(false);
  // When true, the create-folder dialog moves the current selection into the
  // freshly-created folder ("New folder with selection").
  const [folderTakesSelection, setFolderTakesSelection] = React.useState(false);

  // The selection, split by card kind. Every bulk action routes through these
  // (never the raw ids): each kind has its own mutation and its own gate.
  const selectedProjectIds = React.useMemo(
    () => effectiveSelected.filter((id) => projectIdSet.has(id)),
    [effectiveSelected, projectIdSet],
  );
  const selectedFolderIds = React.useMemo(
    () => effectiveSelected.filter((id) => folderIdSet.has(id)),
    [effectiveSelected, folderIdSet],
  );
  const selectedAppIds = React.useMemo(
    () =>
      effectiveSelected.filter(
        (id) => !folderIdSet.has(id) && !projectIdSet.has(id),
      ),
    [effectiveSelected, folderIdSet, projectIdSet],
  );

  // The cards that travel with a lifted one: its own kind's slice of the
  // selection when it belongs to it, otherwise just itself - so a mixed
  // selection moves only the kind the drag started from.
  const dragGroup = React.useCallback(
    (id: string): string[] => {
      const kin = projectIdSet.has(id)
        ? selectedProjectIds
        : folderIdSet.has(id)
          ? selectedFolderIds
          : selectedAppIds;
      return kin.length >= 2 && kin.includes(id) ? kin : [id];
    },
    [
      projectIdSet,
      folderIdSet,
      selectedProjectIds,
      selectedFolderIds,
      selectedAppIds,
    ],
  );

  // Deleting apps/folders is the team-wide super-user action; deleting a project
  // container needs `deploy` (the same gate as its own menu).
  const canDeleteSelection =
    selectionCount > 0 &&
    (selectedProjectIds.length === 0 || canManageProjects) &&
    (selectedAppIds.length + selectedFolderIds.length === 0 ||
      canManageAllFolders);

  const selectionHasNestedApps =
    folderItems.some(
      (f) => selectedFolderIds.includes(f.id) && f.appCount > 0,
    ) ||
    projectItems.some(
      (p) => selectedProjectIds.includes(p.id) && p.appCount > 0,
    );

  const {
    bulkMoveTo,
    moveSelectionInto,
    bulkDelete,
    moveApp,
    moveFoldersOut,
    moveAppToProject,
    moveAppsToProject,
    reorderAppList,
    reorderFolderList,
    reorderProjectList,
  } = useGridMutations({
    arrangement,
    openFolder,
    clearSelection,
    selectedAppIds,
    selectedFolderIds,
    selectedProjectIds,
    bulkDeleteApps,
    onDeleted,
    onRestored,
  });

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
        canDeleteSelection
      ) {
        e.preventDefault();
        setBulkDeleteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionCount, selectAll, clearSelection, canDeleteSelection]);

  const sensors = useSensors(
    // Mouse: a few px of travel before a drag begins, so a click still navigates
    // rather than starting a reorder.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // Touch: a short hold before a drag begins, so a tap navigates and a brief
    // rest-then-swipe still scrolls the page.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Restrict each card kind to the droppables it can meaningfully land on, so
  // closestCenter never resolves a drag onto a neighbour the drop handler would
  // ignore. Folders never enter a project (ADR-0009).
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
      // The "move out" strip runs the full width of the page, so its CENTRE sits
      // mid-screen: closestCenter only chose it when the card was dragged to the
      // middle. Being inside the strip is the whole answer, text included.
      const leaving = pointerWithin({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (c) => String(c.id) === UNGROUP_DROP_ID,
        ),
      });
      if (leaving.length > 0) return leaving;
      if (folderIdSet.has(a)) {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter(
            (c) =>
              folderIdSet.has(String(c.id)) || String(c.id) === UNGROUP_DROP_ID,
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
    setActiveId(null);
    setOverId(null);
    const { active, over } = event;
    if (!over) return;
    const a = String(active.id);
    const o = String(over.id);

    const aIsFolder = folderIdSet.has(a);
    const aIsProject = projectIdSet.has(a);

    const group = dragGroup(a);
    const groupDrag = group.length >= 2;

    // Drop onto the breadcrumb zone: move OUT one level, to the open folder's
    // own parent, or out of the open project, back to the top level.
    if (o === UNGROUP_DROP_ID) {
      if (!canMoveApps) return;
      if (aIsProject) return; // projects live only at the top level
      if (aIsFolder) {
        if (openFolder) moveFoldersOut(group);
        return;
      }
      if (openFolder) {
        const dest = openFolder.parentId ?? null;
        if (groupDrag) bulkMoveTo(dest);
        else moveApp(a, dest);
      } else if (openProject) {
        // `group` (not the raw selection) so a stale off-screen id left in
        // `selected` by a concurrent move is never dragged along.
        if (groupDrag) moveAppsToProject(group, null);
        else moveAppToProject(a, null);
      }
      return;
    }
    if (a === o) return;

    const oIsFolder = folderIdSet.has(o);
    const oIsProject = projectIdSet.has(o);
    if (aIsProject) {
      if (oIsProject && canReorder) reorderProjectList(a, o, group);
    } else if (aIsFolder) {
      if (oIsFolder && canReorder) reorderFolderList(a, o, group);
    } else if (oIsProject) {
      if (!canMoveApps) return;
      if (groupDrag) moveAppsToProject(group, o);
      else moveAppToProject(a, o);
    } else if (oIsFolder) {
      if (!canMoveApps) return;
      if (groupDrag) bulkMoveTo(o);
      else moveApp(a, o);
    } else {
      if (!canReorder) return;
      reorderAppList(a, o, group);
    }
  }

  const appStrategy =
    view === "list" ? verticalListSortingStrategy : rectSortingStrategy;

  const bulkSelection: SelectionBulk = {
    count: selectionCount,
    appCount: selectedAppIds.length,
    canDelete: canDeleteSelection,
    onSelectAll: selectAll,
    onClear: clearSelection,
    onDelete: () => setBulkDeleteOpen(true),
    onNewFolderWithSelection: () => openNewFolder(true),
    moveTargets: allFolders,
    onMoveTo: bulkMoveTo,
  };
  // The block travelling with the lifted card: drives the stacked drag clone and
  // dims every sibling moving with it, so the whole group reads as picked up.
  const activeGroup = activeId ? dragGroup(activeId) : [];
  const groupDragIds = new Set(activeGroup.length >= 2 ? activeGroup : []);
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
        {/* The canvas: the coordinate space the marquee is drawn in and hit-tests
            against. The drag starts anywhere in the page area (see the hook). */}
        <div
          ref={canvasRef}
          // select-none so sweeping a marquee across the section labels /
          // breadcrumb doesn't also start a native text selection.
          className="relative min-h-[60vh] space-y-6 select-none"
        >
          {/* Imperatively positioned by the selection hook during a drag (no
              per-pointermove re-render); hidden when idle. */}
          <div ref={marqueeRef} className={MARQUEE_BOX} />
          {(openFolder || openProject) && (
            <DroppableBreadcrumb
              path={folderPath}
              view={view}
              // Apps move out of a folder or a project; a nested folder moves out
              // of its parent folder. Both light up the "move out" zone.
              dragging={dragging && (activeIsApp || activeIsFolder)}
            />
          )}
          {/* Projects and folders share one grid. Each kind keeps its own
              SortableContext (renders no DOM) so drag-reorder stays scoped to
              its kind (ADR-0009). */}
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
                      selected={selected.has(p.id)}
                      groupDragging={groupDragIds.has(p.id)}
                      locked={lockedIds.has(p.id)}
                      dataKind="project"
                      onSelect={(e) => onItemClick(p.id, e)}
                    >
                      {({ handle, dragActive, isOver }) => (
                        <ProjectContainerCard
                          project={p}
                          view={view}
                          canManage={canManageProjects}
                          dragHandle={handle}
                          dragActive={dragActive}
                          dropActive={isOver && activeIsApp}
                          onDeleted={() => onDeleted([p.id])}
                          onRestored={() => onRestored([p.id])}
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
                      groupDragging={groupDragIds.has(f.id)}
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
                          dropActive={isOver && activeIsApp}
                          onDeleted={() => onDeleted([f.id])}
                          onRestored={() => onRestored([f.id])}
                        />
                      )}
                    </SortableItem>
                  ))}
                </SortableContext>
              )}
            </div>
          )}
          {/* Ungrouped apps always get their own separate grid, same size. */}
          <SortableContext
            items={items.map((p) => p.id)}
            strategy={appStrategy}
          >
            <div className={gridClass(view)}>
              {items.map((p) => (
                <SortableItem
                  key={p.id}
                  id={p.id}
                  dragging={dragging}
                  scaleOut={draggedOverFolder}
                  selected={selected.has(p.id)}
                  groupDragging={groupDragIds.has(p.id)}
                  locked={lockedIds.has(p.id)}
                  dataKind="service"
                  onSelect={(e) => onItemClick(p.id, e)}
                >
                  {({ handle, dragActive }) => (
                    <AppCard
                      project={p}
                      liveState={liveStates.get(p.id)}
                      view={view}
                      dragHandle={handle}
                      dragActive={dragActive}
                      folders={allFolders}
                      canMoveApps={canMoveApps}
                      environments={canMoveApps ? environments : undefined}
                      onDeleted={() => onDeleted([p.id])}
                      onMoved={() => hideMoved(p.id)}
                      onMoveFailed={() => revealMoved(p.id)}
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
          canMoveApps={canMoveApps}
        />
      </>

      {/* The lifted card that follows the cursor. Rendered in a portal above
          everything, so it is never clipped by the grid's overflow/stacking. */}
      <DragOverlay dropAnimation={DRAG_DROP_ANIMATION}>
        {activeProject ? (
          <DragStack count={activeGroup.length}>
            <ProjectContainerCard
              project={activeProject}
              view={view}
              canManage={canManageProjects}
            />
          </DragStack>
        ) : activeFolder ? (
          <DragStack count={activeGroup.length}>
            <FolderCard
              folder={activeFolder}
              view={view}
              isAdminOverride={canManageAllFolders}
              folders={allFolders}
            />
          </DragStack>
        ) : activeApp ? (
          <DragStack
            count={activeGroup.length}
            className={cn(
              "transition-transform duration-200 ease-out",
              draggedOverFolder && "scale-50 opacity-80",
            )}
          >
            <AppCard
              project={activeApp}
              liveState={liveStates.get(activeApp.id)}
              view={view}
              folders={allFolders}
              canMoveApps={canMoveApps}
            />
          </DragStack>
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
            ? `Create a folder and move the ${selectedAppIds.length} selected app(s) into it.`
            : undefined
        }
      />
      <BulkDeleteConfirm
        open={bulkDeleteOpen}
        onOpenChange={(o) => {
          setBulkDeleteOpen(o);
          if (!o) setBulkDeleteApps(false);
        }}
        selectionCount={selectionCount}
        appCount={selectedAppIds.length}
        folderCount={selectedFolderIds.length}
        projectCount={selectedProjectIds.length}
        deleteApps={bulkDeleteApps}
        onDeleteAppsChange={setBulkDeleteApps}
        hasNestedApps={selectionHasNestedApps}
        onConfirm={bulkDelete}
      />
    </DndContext>
  );
}
