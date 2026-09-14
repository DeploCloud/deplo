import type { FolderCardData } from "../folder-card";
import type { ProjectCardData } from "../project-container-card";
import type { AppSummary } from "@/lib/data/apps/summary";
import type { OverviewAppStateView } from "./overview-state";

export type FolderRef = { id: string; name: string };
export type ProjectRef = { id: string; name: string };

// TrailSeg is one breadcrumb segment; `href` overrides the default folder link
// (used for the project segment, which opens `/?project=<id>`).
export type TrailSeg = { id: string; name: string; href?: string };

export interface AppsGridProps {
  // The apps to DISPLAY: a folder's contents, the ungrouped top level, or flat
  // search results. The card objects always come from the latest server props.
  services: AppSummary[];
  // The FULL team project order, ids only: a within-group reorder persists
  // against it, so the other groups' relative order is preserved.
  allAppIds: string[];
  /** Folder cards to show before the apps (top level only; [] otherwise). */
  folders: FolderCardData[];
  /** Project CONTAINER cards, shown above the folders (team top level only). */
  projects: ProjectCardData[];
  /** Every team folder (id + name) for the cards' "Move to folder" menu. */
  allFolders: FolderRef[];
  /** The folder currently open (with its parent), or null at the top level. */
  openFolder: (FolderRef & { parentId: string | null }) | null;
  // The project container currently open, or null. Mutually exclusive with
  // `openFolder` - a folder param wins over a project param.
  openProject: ProjectRef | null;
  /** Breadcrumb trail from the top level down to the open folder or project. */
  folderPath: TrailSeg[];
  view: "grid" | "list";
  /** Drag-to-REORDER is enabled: `manage_team` or instance admin (off in search). */
  canReorder: boolean;
  /** Drag-into-folder/project and the Move actions: the viewer holds `move_apps`. */
  canMoveApps: boolean;
  /** The viewer may CREATE folders (has `deploy`, or is an instance admin). */
  canCreateFolder: boolean;
  // The viewer is a super-user (manage_team / instance admin): gates the team-wide
  // bulk move/delete, reorder, and the manage menu on folders they don't own.
  canManageAllFolders: boolean;
  // The viewer may mutate project containers (holds `deploy`, or instance admin):
  // gates each project card's menu and the app cards' "Move to environment".
  canManageProjects: boolean;
  /** The open project's environments, feeding "Move to environment" (ADR-0009). */
  environments?: { id: string; name: string }[];
}

// GridProps is the props minus whatever the user just deleted, plus the callbacks
// that hide the next one and put back a refused delete.
export type GridProps = AppsGridProps & {
  liveStates: ReadonlyMap<string, OverviewAppStateView>;
  onDeleted: (ids: string[]) => void;
  onRestored: (ids: string[]) => void;
};

// gridClass is the layout both grids share: 1 column on mobile, 2 from sm up, and
// 3 only on Full-HD screens and wider (the `3xl` breakpoint).
export function gridClass(view: "grid" | "list"): string {
  return view === "list"
    ? "flex flex-col gap-3"
    : "grid gap-4 sm:grid-cols-2 3xl:grid-cols-3";
}
