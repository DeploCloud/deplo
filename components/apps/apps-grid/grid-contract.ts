import type { FolderCardData } from "../folder-card";
import type { ProjectCardData } from "../project-container-card";
import type { AppSummary } from "@/lib/data/apps/summary";
import type { OverviewAppStateView } from "./overview-state";

export type FolderRef = { id: string; name: string };
export type ProjectRef = { id: string; name: string };

export type TrailSeg = { id: string; name: string; href?: string };

export interface AppsGridProps {
  services: AppSummary[];
  allAppIds: string[];
  folders: FolderCardData[];
  projects: ProjectCardData[];
  allFolders: FolderRef[];
  openFolder: (FolderRef & { parentId: string | null }) | null;
  openProject: ProjectRef | null;
  folderPath: TrailSeg[];
  view: "grid" | "list";
  canReorder: boolean;
  canMoveApps: boolean;
  canCreateFolder: boolean;
  canManageAllFolders: boolean;
  canManageProjects: boolean;
  environments?: { id: string; name: string }[];
}

export type GridProps = AppsGridProps & {
  liveStates: ReadonlyMap<string, OverviewAppStateView>;
  onDeleted: (ids: string[]) => void;
  onRestored: (ids: string[]) => void;
};

export function gridClass(view: "grid" | "list"): string {
  return view === "list"
    ? "flex flex-col gap-3"
    : "grid gap-4 sm:grid-cols-2 2xl:grid-cols-3";
}
