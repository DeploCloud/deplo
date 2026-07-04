import Link from "next/link";
import { Plus, Rocket, Folder, Bell, Eye, ArrowUpRight } from "lucide-react";
import { listProjects } from "@/lib/data/projects";
import { listFolders } from "@/lib/data/folders";
import { listActivity } from "@/lib/data/activity";
import { isInstanceAdmin, hasCapability } from "@/lib/membership";
import {
  folderCapabilities,
  folderIsOwnerOrAdmin,
} from "@/lib/data/folder-access";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { ProjectsGrid } from "@/components/projects/projects-grid";
import { ProjectSearch } from "@/components/projects/project-search";
import { AddNewMenu } from "@/components/shared/add-new-menu";
import { timeAgo } from "@/lib/utils";

export default async function OverviewPage(props: PageProps<"/">) {
  const {
    q,
    view: viewParam,
    folder: folderParam,
  } = await props.searchParams;
  const query = (Array.isArray(q) ? q[0] : q)?.toLowerCase() ?? "";
  const viewRaw = Array.isArray(viewParam) ? viewParam[0] : viewParam;
  const view = viewRaw === "list" ? "list" : "grid";
  const folderId =
    (Array.isArray(folderParam) ? folderParam[0] : folderParam) ?? "";

  const [
    projects,
    folders,
    activity,
    isAdmin,
    canManageTeam,
    canManageMembers,
    canDeploy,
  ] = await Promise.all([
    listProjects(),
    listFolders(),
    listActivity(6),
    isInstanceAdmin(),
    hasCapability("manage_team"),
    hasCapability("manage_members"),
    hasCapability("deploy"),
  ]);
  const canManageOrder = isAdmin || canManageTeam;
  // Creating a folder is gated the same as creating a project: any `deploy`
  // holder (or an instance admin) may do it — NOT the manage_team super-user gate.
  const canCreateFolder = isAdmin || canDeploy;
  // Team-wide bulk/reorder actions (and the manage menu on folders one doesn't
  // own) stay on the super-user flag; aliased for clarity at the call sites.
  const canManageAllFolders = canManageOrder;

  // What the grid shows:
  //  - searching: every matching project, flat, across all folders (folders
  //    hidden) so a project inside a folder is still findable;
  //  - a folder open: that folder's direct projects + its child folders;
  //  - otherwise (top level): ungrouped projects + the top-level folders.
  const openFolder =
    !query && folderId ? folders.find((f) => f.id === folderId) ?? null : null;

  const matches = (p: (typeof projects)[number]) =>
    p.name.toLowerCase().includes(query) ||
    Boolean(p.repo?.repo.toLowerCase().includes(query)) ||
    Boolean(p.productionUrl?.toLowerCase().includes(query));

  const visibleProjects = query
    ? projects.filter(matches)
    : openFolder
      ? projects.filter((p) => p.folderId === openFolder.id)
      : projects.filter((p) => !p.folderId);
  // Folders nest: show the children of the open folder, or the top-level folders
  // (no parent) at the root. Hidden entirely during a search.
  const visibleFolders = query
    ? []
    : openFolder
      ? folders.filter((f) => (f.parentId ?? null) === openFolder.id)
      : folders.filter((f) => (f.parentId ?? null) === null);

  // Enrich each visible folder with the CURRENT caller's effective per-folder
  // caps and whether they may share it — the two fields the folder cards gate
  // their own rename/colour/move/delete/share menu on. `listFolders` (the data
  // read) doesn't carry these (they're per-caller, not stored), so we derive them
  // here, only for the handful of folders actually rendered.
  const enrichedFolders = await Promise.all(
    visibleFolders.map(async (f) => ({
      ...f,
      capabilities: await folderCapabilities(f.id),
      isOwner: await folderIsOwnerOrAdmin(f.id),
    })),
  );

  // Breadcrumb trail from the top level down to (and including) the open folder,
  // walking `parentId` up. Guarded against a stale cycle so it always terminates.
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const folderPath: { id: string; name: string }[] = [];
  {
    const seen = new Set<string>();
    let cur = openFolder;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      folderPath.unshift({ id: cur.id, name: cur.name });
      cur = cur.parentId ? folderById.get(cur.parentId) ?? null : null;
    }
  }

  const allFolders = folders.map((f) => ({ id: f.id, name: f.name }));
  const allProjectIds = projects.map((p) => p.id);

  // Drag-to-reorder writes a team-wide order, so it is gated on permission; it is
  // also disabled mid-search (reordering a filtered list would persist a partial
  // order). When off, the grid renders statically.
  const canReorder = canManageOrder && !query;

  const nothingToShow =
    visibleProjects.length === 0 && visibleFolders.length === 0;
  // Re-seed the grid's optimistic state only on a structural change (navigation,
  // search, add/remove of a project or folder) — never on a pure reorder/move,
  // so a drag survives its own drop. See ProjectsGrid.
  const gridKey = [
    view,
    query,
    openFolder?.id ?? "",
    [...allProjectIds].sort().join(","),
    folders
      .map((f) => f.id)
      .sort()
      .join(","),
  ].join("|");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      {/* Right rail */}
      <div className="order-2 space-y-6 lg:order-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {activity.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No recent activity.
              </p>
            )}
            {activity.map((a) => (
              <div key={a.id} className="flex items-start gap-2.5 text-xs">
                <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary">
                  <Bell className="size-3 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-foreground">{a.message}</p>
                  <p className="text-muted-foreground">
                    {a.actor} · {timeAgo(a.createdAt)}
                  </p>
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link href="/activity">View all activity</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Recent Previews</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-center">
              <Eye className="size-5 text-muted-foreground" />
              <p className="max-w-50 text-xs text-muted-foreground">
                Preview deployments you create will appear here.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Projects */}
      <div className="order-1 space-y-5 lg:order-1">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <AddNewMenu
            canManageMembers={canManageMembers}
            canCreateFolder={canCreateFolder}
            isAdmin={isAdmin}
          />
        </div>

        <ProjectSearch
          initialQuery={query}
          initialView={view}
          initialFolder={openFolder?.id ?? ""}
        />

        {nothingToShow ? (
          query ? (
            <EmptyState
              icon={Rocket}
              title="No projects match your search"
              description={`Nothing found for “${query}”.`}
            />
          ) : openFolder ? (
            <EmptyState
              icon={Folder}
              title={`${openFolder.name} is empty`}
              description="Drag projects onto this folder from All projects, or use a project’s “Move to folder” menu."
              action={
                <Button asChild variant="outline">
                  <Link href={view === "list" ? "/?view=list" : "/"}>
                    Back to all projects
                  </Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Rocket}
              title="No projects yet"
              description="Import a Git repository or start from a template to deploy your first app."
              action={
                <div className="flex gap-2">
                  <Button asChild>
                    <Link href="/new">
                      <Plus className="size-4" />
                      Import Project
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="/templates">
                      Browse Templates
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              }
            />
          )
        ) : (
          <ProjectsGrid
            key={gridKey}
            projects={visibleProjects}
            allProjectIds={allProjectIds}
            folders={enrichedFolders}
            allFolders={allFolders}
            openFolder={
              openFolder
                ? {
                    id: openFolder.id,
                    name: openFolder.name,
                    parentId: openFolder.parentId ?? null,
                  }
                : null
            }
            folderPath={folderPath}
            view={view}
            canReorder={canReorder}
            canCreateFolder={canCreateFolder}
            canManageAllFolders={canManageAllFolders}
          />
        )}
      </div>
    </div>
  );
}
