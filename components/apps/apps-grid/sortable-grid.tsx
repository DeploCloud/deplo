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

const DRAG_DROP_ANIMATION: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

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

  const [activeId, setActiveId] = React.useState<string | null>(null);
  const dragging = activeId !== null;
  const [overId, setOverId] = React.useState<string | null>(null);

  const activeIsFolder = activeId !== null && folderIdSet.has(activeId);
  const activeIsProject = activeId !== null && projectIdSet.has(activeId);
  const activeIsApp = activeId !== null && !activeIsFolder && !activeIsProject;
  const activeFolder = activeId ? (folderById.get(activeId) ?? null) : null;
  const activeProject = activeId ? (projectById.get(activeId) ?? null) : null;
  const activeApp = activeIsApp ? (byId.get(activeId!) ?? null) : null;
  const draggedOverFolder =
    activeIsApp &&
    overId != null &&
    (folderIdSet.has(overId) || projectIdSet.has(overId));

  const lockedIds = React.useMemo(
    () =>
      new Set([
        ...projectItems.filter((p) => p.migrationRunId).map((p) => p.id),
        ...items.filter((p) => p.migrationRunId).map((p) => p.id),
      ]),
    [projectItems, items],
  );

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

  const effectiveSelected = React.useMemo(
    () => selectableIds.filter((id) => selected.has(id)),
    [selectableIds, selected],
  );
  const selectionCount = effectiveSelected.length;

  const [createFolderOpen, setCreateFolderOpen] = React.useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [bulkDeleteApps, setBulkDeleteApps] = React.useState(false);
  const [folderTakesSelection, setFolderTakesSelection] = React.useState(false);

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
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

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

    if (o === UNGROUP_DROP_ID) {
      if (!canMoveApps) return;
      if (aIsProject) return;
      if (aIsFolder) {
        if (openFolder) moveFoldersOut(group);
        return;
      }
      if (openFolder) {
        const dest = openFolder.parentId ?? null;
        if (groupDrag) bulkMoveTo(dest);
        else moveApp(a, dest);
      } else if (openProject) {
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
        <div
          ref={canvasRef}
          className="relative min-h-[60vh] space-y-6 select-none"
        >
          <div ref={marqueeRef} className={MARQUEE_BOX} />
          {(openFolder || openProject) && (
            <DroppableBreadcrumb
              path={folderPath}
              view={view}
              dragging={dragging && (activeIsApp || activeIsFolder)}
            />
          )}
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
