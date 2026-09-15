"use client";

import { AppCard } from "../app-card";
import { FolderCard } from "../folder-card";
import { ProjectContainerCard } from "../project-container-card";
import { FolderTrail } from "./folder-trail";
import { gridClass, type GridProps } from "./grid-contract";

export function StaticGrid({
  services,
  folders,
  projects,
  allFolders,
  openFolder,
  openProject,
  folderPath,
  view,
  canMoveApps,
  canManageAllFolders,
  canManageProjects,
  environments,
  liveStates,
  onDeleted,
  onRestored,
}: GridProps) {
  return (
    <div className="relative min-h-[40vh] space-y-6">
      {(openFolder || openProject) && (
        <div className="px-1 py-1">
          <FolderTrail path={folderPath} view={view} />
        </div>
      )}
      {(projects.length > 0 || folders.length > 0) && (
        <div className={gridClass(view)}>
          {projects.map((p) => (
            <ProjectContainerCard
              key={p.id}
              project={p}
              view={view}
              canManage={canManageProjects}
              onDeleted={() => onDeleted([p.id])}
              onRestored={() => onRestored([p.id])}
            />
          ))}
          {folders.map((f) => (
            <FolderCard
              key={f.id}
              folder={f}
              view={view}
              isAdminOverride={canManageAllFolders}
              folders={allFolders}
              onDeleted={() => onDeleted([f.id])}
              onRestored={() => onRestored([f.id])}
            />
          ))}
        </div>
      )}
      {services.length > 0 && (
        <div className={gridClass(view)}>
          {services.map((p) => (
            <AppCard
              key={p.id}
              project={p}
              liveState={liveStates.get(p.id)}
              view={view}
              folders={allFolders}
              canMoveApps={canMoveApps}
              environments={canMoveApps ? environments : undefined}
              onDeleted={() => onDeleted([p.id])}
            />
          ))}
        </div>
      )}
    </div>
  );
}
