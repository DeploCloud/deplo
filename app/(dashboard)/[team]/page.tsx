import Link from "@/components/ui/link";
import { Plus, Rocket, Folder, Boxes, Eye, ArrowUpRight } from "lucide-react";
import { listApps } from "@/lib/data/apps";
import { listFolders } from "@/lib/data/folders";
import { listProjects } from "@/lib/data/projects";
import { listEnvironmentsForProject } from "@/lib/data/environments";
import { listActivity } from "@/lib/data/activity";
import { listDatabases } from "@/lib/data/databases";
import {
  isInstanceAdmin,
  hasCapability,
  hasCapabilityAnywhere,
  reachesWholeTeam,
} from "@/lib/membership";
import {
  folderCapabilities,
  folderIsOwnerOrAdmin,
} from "@/lib/data/folder-access";
import { nodeCapabilities } from "@/lib/data/node-access";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { AppsGrid, FolderTrail } from "@/components/apps/apps-grid";
import { ArchiveDropZone } from "@/components/apps/archive-drop-zone";
import { AppsGraphic } from "@/components/apps/apps-graphic";
import { AppSearch } from "@/components/apps/app-search";
import { EnvironmentSwitcher } from "@/components/apps/environment-switcher";
import {
  projectHref,
  newAppHref,
  templatesHref,
  type OverviewPlacement,
} from "@/lib/overview-links";
import { AddNewMenu } from "@/components/shared/add-new-menu";
import { PageHeader } from "@/components/shared/page-header";
import { WelcomeCelebration } from "@/components/shared/welcome-celebration";
import { NetworkSweepNotice } from "@/components/shared/network-sweep-notice";
import { networkSweepFailures } from "@/lib/deploy/network-migration";
import {
  ActivityTimeline,
  toActivityItem,
} from "@/components/activity/activity-timeline";

export default async function OverviewPage(props: PageProps<"/[team]">) {
  const {
    q,
    view: viewParam,
    folder: folderParam,
    project: projectParam,
    env: envParam,
    welcome,
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
    teamWideReach,
    isAdmin,
    canManageTeam,
    canDeploy,
    canCreateDatabase,
    canCreateFolder,
    canCreateProject,
    canMoveApps,
  ] = await Promise.all([
    listApps(),
    listFolders(),
    listProjects(),
    listActivity(6),
    // `listDatabases` is team-wide and refuses a partial-reach role; such a role
    // sees no database row in the trail either.
    reachesWholeTeam(),
    isInstanceAdmin(),
    hasCapability("manage_team"),
    hasCapability("create_apps"),
    // The "Add New ▸ Database" entry links to the Storage page's create dialog,
    // so it is offered only to someone who may actually create one.
    hasCapability("create_databases"),
    // Folders and projects each have their OWN create capability, and
    // `requireCapability` gives an instance admin no bypass, so asking for exactly
    // what createFolder/createProject ask for is what keeps a menu entry from opening a
    hasCapability("create_folders"),
    hasCapability("create_projects"),
    // Moving an app is its own permission, and it is the one a folder or app GRANT can
    // hand out on a single corner of the fleet - so this asks the wider "anywhere"
    // question.
    hasCapabilityAnywhere("move_apps"),
  ]);
  const activityDatabases = teamWideReach ? await listDatabases() : [];
  // How many stacks stayed on the old shared network. 0 on every instance that
  // never had one, which is every new install.
  const networkSweepFailed = await networkSweepFailures();
  const canManageOrder = isAdmin || canManageTeam;
  // Shown instead of a create button wherever the viewer can't create apps, so
  // an empty Overview says what is missing instead of looking broken.
  const noCreateAppsNote =
    "You don't have permission to create apps. Ask a team admin for the “Create apps” permission.";
  // Team-wide bulk/reorder actions (and the manage menu on folders one doesn't
  // own) stay on the super-user flag; aliased for clarity at the call sites.
  const canManageAllFolders = canManageOrder;

  // What the grid shows: - searching: every matching app, flat, across all folders
  // and projects (folders/projects hidden) so anything nested is still findable; - a
  // folder open: that folder's direct apps + its child folders; - a project open: the
  const openFolder =
    !query && folderId
      ? (folders.find((f) => f.id === folderId) ?? null)
      : null;
  const openProject =
    !query && !openFolder && projectId
      ? (projects.find((p) => p.id === projectId) ?? null)
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

  // Enrich each visible folder with the CURRENT caller's effective per-folder caps
  // and whether they may share it - the two fields the folder cards gate their own
  // rename/colour/move/delete/share menu on.
  const enrichedFolders = await Promise.all(
    visibleFolders.map(async (f) => ({
      ...f,
      capabilities: await folderCapabilities(f.id),
      isOwner: await folderIsOwnerOrAdmin(f.id),
    })),
  );

  // Same for the project tiles: their "All apps" actions ask what the caller may
  // do to the apps INSIDE, which a project grant can hand out on its own.
  const enrichedProjects = await Promise.all(
    visibleProjects.map(async (p) => ({
      ...p,
      capabilities: await nodeCapabilities({ kind: "project", id: p.id }),
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
      cur = cur.parentId ? (folderById.get(cur.parentId) ?? null) : null;
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
  // HERE - in the open folder, or in the open project's selected environment.
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
  // Dragging a card ONTO a folder or a project moves it, which is a different
  // permission from arranging the grid - and the one that used to ride along with
  // `manage_team`, leaving "Move & reorder apps" with nothing to do here.

  const nothingToShow =
    visibleApps.length === 0 &&
    visibleFolders.length === 0 &&
    visibleProjects.length === 0;
  // Re-seed the grid's optimistic state only on a structural change (navigation,
  // search, add/remove of an app, folder or project), never on a pure
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
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <WelcomeCelebration show={welcome === "1"} />
      {/* Drop a code archive anywhere here and it opens the wizard on Upload
          with the file already in hand. */}
      {canDeploy && (
        <ArchiveDropZone href={newAppHref(placement, { source: "upload" })} />
      )}
      {/* Right rail */}
      <div className="order-2 space-y-6 lg:order-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm lg:text-sm">
              Recent activity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {activity.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No recent activity.
              </p>
            )}
            <ActivityTimeline
              variant="compact"
              showMark={false}
              items={activity.map(toActivityItem)}
              appLinks={Object.fromEntries(
                services.map((s) => [
                  s.id,
                  { name: s.name, slug: s.slug, logo: s.logo },
                ]),
              )}
              databaseLinks={Object.fromEntries(
                activityDatabases.map((d) => [
                  d.id,
                  { name: d.name, logo: d.logo, type: d.type },
                ]),
              )}
            />
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link href="/activity">View all activity</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Overview: projects, folders and apps */}
      <div className="order-1 space-y-5 lg:order-1">
        <PageHeader
          title="Overview"
          actions={
            <AddNewMenu
              canCreateApp={canDeploy}
              canCreateDatabase={canCreateDatabase}
              canCreateFolder={canCreateFolder}
              canCreateProject={canCreateProject}
              // Drill-in context so "Folder" nests under the folder currently open (ADR-0009:
              // folders nest via parentId). Null inside a project - folders never live in a
              // project, so a folder made there stays at the top level.
              parentFolder={
                openFolder ? { id: openFolder.id, name: openFolder.name } : null
              }
              // …and so a NEW APP created from here is created IN the open folder
              // (or the selected environment of the open project) instead of
              // landing at the team top level.
              placement={placement}
            />
          }
        />

        {/* The stacks the network-isolation move could not reach, if any. An
            instance-wide count and an instance-wide remedy, so only an instance
            admin is shown it. */}
        {isAdmin && (
          <NetworkSweepNotice failed={networkSweepFailed} canRetry={isAdmin} />
        )}

        {/**
         * The project drill-in's environment dropdown (ADR-0009) sits inline in the
         * toolbar, at the end just before the grid/list toggle.
         */}
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
                // A migration still writing this project owns its environments
                // too, and every one of these actions is refused server-side.
                canManage={
                  (canDeploy || isAdmin) && !openProject.migrationRunId
                }
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
            // An empty open folder renders no grid, but the breadcrumb is the only way back out,
            // so keep the "Overview / …" trail above the empty state regardless.
            <div className="space-y-6">
              <div className="px-1 py-1">
                <FolderTrail path={trailPath} view={view} />
              </div>
              <EmptyState
                icon={Folder}
                title={`${openFolder.name} is empty`}
                description={
                  canDeploy
                    ? "Create an app here, drag apps onto this folder from the Overview, or use an app’s “Move to folder” menu."
                    : noCreateAppsNote
                }
                action={
                  <div className="flex gap-2">
                    {/* Creating from inside the folder creates IN the folder -
                        the drill-in rides along as ?folder=. Offered only to
                        someone createApp won't refuse. */}
                    {canDeploy && (
                      <Button asChild>
                        <Link href={newAppHref(placement)}>
                          <Plus className="size-4" />
                          New app
                        </Link>
                      </Button>
                    )}
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
                description={
                  canDeploy
                    ? "Create an app here, drag apps onto this project from the Overview, or use an app’s “Move to folder” menu."
                    : noCreateAppsNote
                }
                action={
                  <div className="flex gap-2">
                    {/* Created in the SELECTED environment of this project. */}
                    {canDeploy && (
                      <Button asChild>
                        <Link href={newAppHref(placement)}>
                          <Plus className="size-4" />
                          New app
                        </Link>
                      </Button>
                    )}
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
              graphic={<AppsGraphic />}
              title="No apps yet"
              docs="deploy.sources"
              description={
                canDeploy
                  ? "Import a Git repository or start from a template to deploy your first app."
                  : noCreateAppsNote
              }
              action={
                canDeploy ? (
                  <div className="flex gap-2">
                    <Button asChild>
                      <Link href={newAppHref(placement)}>
                        <Plus className="size-4" />
                        New app
                      </Link>
                    </Button>
                    <Button asChild variant="outline">
                      <Link href={templatesHref(placement)}>
                        Browse Templates
                        <ArrowUpRight className="size-4" />
                      </Link>
                    </Button>
                  </div>
                ) : undefined
              }
            />
          )
        ) : (
          <AppsGrid
            key={gridKey}
            services={visibleApps}
            allAppIds={allAppIds}
            folders={enrichedFolders}
            projects={enrichedProjects}
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
            canMoveApps={canMoveApps}
            canCreateFolder={canCreateFolder}
            canManageAllFolders={canManageAllFolders}
            // The project card's manage menu (rename, recolor, delete, its environments) - each
            // item has its own capability server-side, so this stays the wider "can shape the
            // fleet" proxy it has always been rather than borrowing the folder gate.
            canManageProjects={isAdmin || canDeploy}
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
