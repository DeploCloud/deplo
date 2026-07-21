import Link from "next/link";
import {
  Plus,
  Rocket,
  Folder,
  Boxes,
  Bell,
  Eye,
  ArrowUpRight,
} from "lucide-react";
import { listApps } from "@/lib/data/apps";
import { listFolders } from "@/lib/data/folders";
import { listProjects } from "@/lib/data/projects";
import { listEnvironmentsForProject } from "@/lib/data/environments";
import { listActivity } from "@/lib/data/activity";
import { isInstanceAdmin, hasCapability } from "@/lib/membership";
import {
  folderCapabilities,
  folderIsOwnerOrAdmin,
} from "@/lib/data/folder-access";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { AppsGrid, FolderTrail } from "@/components/apps/apps-grid";
import { AppSearch } from "@/components/apps/app-search";
import { EnvironmentSwitcher } from "@/components/apps/environment-switcher";
import {
  projectHref,
  newAppHref,
  templatesHref,
  type OverviewPlacement,
} from "@/lib/overview-links";
import { AddNewMenu } from "@/components/shared/add-new-menu";
import { timeAgo } from "@/lib/utils";

export default async function OverviewPage(props: PageProps<"/">) {
  const {
    q,
    view: viewParam,
    folder: folderParam,
    project: projectParam,
    env: envParam,
  } = await props.searchParams;
  const query = (Array.isArray(q) ? q[0] : q)?.toLowerCase() ?? "";
  const viewRaw = Array.isArray(viewParam) ? viewParam[0] : viewParam;
  const view = viewRaw === "list" ? "list" : "grid";
  const folderId =
    (Array.isArray(folderParam) ? folderParam[0] : folderParam) ?? "";
  const projectId =
    (Array.isArray(projectParam) ? projectParam[0] : projectParam) ?? "";
  const envId = (Array.isArray(envParam) ? envParam[0] : envParam) ?? "";

  const [
    services,
    folders,
    projects,
    activity,
    isAdmin,
    canManageTeam,
    canManageMembers,
    canDeploy,
  ] = await Promise.all([
    listApps(),
    listFolders(),
    listProjects(),
    listActivity(6),
    isInstanceAdmin(),
    hasCapability("manage_team"),
    hasCapability("manage_members"),
    hasCapability("deploy"),
  ]);
  const canManageOrder = isAdmin || canManageTeam;
  // Creating a folder or a project container is gated the same as creating an
  // app: any `deploy` holder (or an instance admin) may do it — NOT the
  // manage_team super-user gate.
  const canCreateFolder = isAdmin || canDeploy;
  // Team-wide bulk/reorder actions (and the manage menu on folders one doesn't
  // own) stay on the super-user flag; aliased for clarity at the call sites.
  const canManageAllFolders = canManageOrder;

  // What the grid shows:
  //  - searching: every matching app, flat, across all folders and projects
  //    (folders/projects hidden) so anything nested is still findable;
  //  - a folder open: that folder's direct apps + its child folders;
  //  - a project open: the apps of the SELECTED ENVIRONMENT (ADR-0009 —
  //    each environment is a sub-folder of apps, picked via the dropdown in
  //    the toolbar). The view mirrors a folder view — just its apps;
  //  - otherwise (top level): projects, top-level folders, ungrouped apps.
  const openFolder =
    !query && folderId ? folders.find((f) => f.id === folderId) ?? null : null;
  const openProject =
    !query && !openFolder && projectId
      ? projects.find((p) => p.id === projectId) ?? null
      : null;

  // The open project's environments and the selected one (?env= param, falling
  // back to the project default, then to the first by position).
  const environments = openProject
    ? await listEnvironmentsForProject(openProject.id)
    : [];
  const defaultEnv =
    environments.find((e) => e.isDefault) ?? environments[0] ?? null;
  const selectedEnv =
    (envId ? environments.find((e) => e.id === envId) : null) ?? defaultEnv;

  const matches = (p: (typeof services)[number]) =>
    p.name.toLowerCase().includes(query) ||
    Boolean(p.repo?.repo.toLowerCase().includes(query)) ||
    Boolean(p.productionUrl?.toLowerCase().includes(query));

  const visibleApps = query
    ? services.filter(matches)
    : openFolder
      ? services.filter((p) => p.folderId === openFolder.id)
      : openProject
        ? services.filter(
            (p) =>
              (p.projectId ?? null) === openProject.id &&
              !p.folderId &&
              // A pre-0020 row with no environment counts as the default env,
              // so nothing silently disappears from the project view.
              (p.environmentId ?? defaultEnv?.id) === selectedEnv?.id,
          )
        : services.filter((p) => !p.folderId && !p.projectId);
  // Folders nest among themselves only (ADR-0009: never inside a project): show
  // the children of the open folder, or every root folder at the top level.
  const visibleFolders = query
    ? []
    : openFolder
      ? folders.filter((f) => (f.parentId ?? null) === openFolder.id)
      : openProject
        ? []
        : folders.filter((f) => (f.parentId ?? null) === null);
  // Project containers only ever show at the true top level.
  const visibleProjects = query || openFolder || openProject ? [] : projects;

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
  // An open project is its own (single-segment) trail.
  const trailPath = openProject
    ? [
        {
          id: openProject.id,
          name: openProject.name,
          href: projectHref(openProject.id, view),
        },
      ]
    : folderPath;

  // The drill-in the user is standing in, threaded into every creation flow
  // (Add New menu, empty-state buttons) so an app created from here is born
  // HERE — in the open folder, or in the open project's selected environment.
  const placement: OverviewPlacement | null = openFolder
    ? { folderId: openFolder.id }
    : openProject
      ? { projectId: openProject.id, environmentId: selectedEnv?.id ?? null }
      : null;

  const allFolders = folders.map((f) => ({ id: f.id, name: f.name }));
  const allAppIds = services.map((p) => p.id);

  // Drag-to-reorder writes a team-wide order, so it is gated on permission; it is
  // also disabled mid-search (reordering a filtered list would persist a partial
  // order). When off, the grid renders statically.
  const canReorder = canManageOrder && !query;

  const nothingToShow =
    visibleApps.length === 0 &&
    visibleFolders.length === 0 &&
    visibleProjects.length === 0;
  // Re-seed the grid's optimistic state only on a structural change (navigation,
  // search, add/remove of an app, folder or project) — never on a pure
  // reorder/move, so a drag survives its own drop. See AppsGrid.
  const gridKey = [
    view,
    query,
    openFolder?.id ?? "",
    openProject?.id ?? "",
    selectedEnv?.id ?? "",
    [...allAppIds].sort().join(","),
    folders
      .map((f) => f.id)
      .sort()
      .join(","),
    projects
      .map((p) => p.id)
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
      </div>

      {/* Overview: projects, folders and apps */}
      <div className="order-1 space-y-5 lg:order-1">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <AddNewMenu
            canManageMembers={canManageMembers}
            canCreateFolder={canCreateFolder}
            isAdmin={isAdmin}
            // Drill-in context so "New folder" nests under the folder currently
            // open (ADR-0009: folders nest via parentId). Null inside a project —
            // folders never live in a project — so a folder made there stays at
            // the top level.
            parentFolder={
              openFolder ? { id: openFolder.id, name: openFolder.name } : null
            }
            // …and so a NEW APP created from here is created IN the open folder
            // (or the selected environment of the open project) instead of
            // landing at the team top level.
            placement={placement}
          />
        </div>

        {/* The project drill-in's environment dropdown (ADR-0009) sits inline in
            the toolbar, at the end just before the grid/list toggle. It is also
            the whole environment-management surface (rename / default / delete /
            create), so no separate panel is needed below the grid. */}
        <AppSearch
          initialQuery={query}
          initialView={view}
          initialFolder={openFolder?.id ?? ""}
          initialProject={openProject?.id ?? ""}
          initialEnv={openProject && selectedEnv ? selectedEnv.id : ""}
          environmentSwitcher={
            openProject && selectedEnv ? (
              <EnvironmentSwitcher
                projectId={openProject.id}
                view={view}
                environments={environments.map((e) => ({
                  id: e.id,
                  name: e.name,
                  isDefault: e.isDefault,
                }))}
                selectedId={selectedEnv.id}
                canManage={canDeploy || isAdmin}
              />
            ) : undefined
          }
        />

        {nothingToShow ? (
          query ? (
            <EmptyState
              icon={Rocket}
              title="No apps match your search"
              description={`Nothing found for “${query}”.`}
            />
          ) : openFolder ? (
            // An empty open folder renders no grid, but the breadcrumb is the
            // only way back out — so keep the "Overview / …" trail above the
            // empty state regardless. The px-1 py-1 must match the grid's
            // DroppableBreadcrumb so the trail never shifts between the empty and
            // populated views of the same folder.
            <div className="space-y-6">
              <div className="px-1 py-1">
                <FolderTrail path={trailPath} view={view} />
              </div>
              <EmptyState
                icon={Folder}
                title={`${openFolder.name} is empty`}
                description="Create an app here, drag apps onto this folder from the Overview, or use an app’s “Move to folder” menu."
                action={
                  <div className="flex gap-2">
                    {/* Creating from inside the folder creates IN the folder —
                        the drill-in rides along as ?folder=. */}
                    <Button asChild>
                      <Link href={newAppHref(placement)}>
                        <Plus className="size-4" />
                        New app
                      </Link>
                    </Button>
                    <Button asChild variant="outline">
                      <Link href={view === "list" ? "/?view=list" : "/"}>
                        Back to overview
                      </Link>
                    </Button>
                  </div>
                }
              />
            </div>
          ) : openProject ? (
            <div className="space-y-6">
              <div className="px-1 py-1">
                <FolderTrail path={trailPath} view={view} />
              </div>
              <EmptyState
                icon={Boxes}
                title={
                  selectedEnv
                    ? `No apps in ${selectedEnv.name}`
                    : `${openProject.name} is empty`
                }
                description="Create an app here, drag apps onto this project from the Overview, or use an app’s “Move to folder” menu."
                action={
                  <div className="flex gap-2">
                    {/* Created in the SELECTED environment of this project. */}
                    <Button asChild>
                      <Link href={newAppHref(placement)}>
                        <Plus className="size-4" />
                        New app
                      </Link>
                    </Button>
                    <Button asChild variant="outline">
                      <Link href={view === "list" ? "/?view=list" : "/"}>
                        Back to overview
                      </Link>
                    </Button>
                  </div>
                }
              />
            </div>
          ) : (
            <EmptyState
              icon={Rocket}
              title="No apps yet"
              description="Import a Git repository or start from a template to deploy your first app."
              action={
                <div className="flex gap-2">
                  <Button asChild>
                    <Link href={newAppHref(placement)}>
                      <Plus className="size-4" />
                      Import App
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href={templatesHref(placement)}>
                      Browse Templates
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              }
            />
          )
        ) : (
          <AppsGrid
            key={gridKey}
            services={visibleApps}
            allAppIds={allAppIds}
            folders={enrichedFolders}
            projects={visibleProjects}
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
            openProject={
              openProject
                ? { id: openProject.id, name: openProject.name }
                : null
            }
            folderPath={trailPath}
            view={view}
            canReorder={canReorder}
            canCreateFolder={canCreateFolder}
            canManageAllFolders={canManageAllFolders}
            canManageProjects={canCreateFolder}
            environments={
              openProject
                ? environments.map((e) => ({ id: e.id, name: e.name }))
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
