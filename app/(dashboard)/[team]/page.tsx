import Link from "@/components/ui/link";
import { Plus, Rocket, Folder, Boxes, ArrowUpRight } from "lucide-react";
import { listApps } from "@/lib/data/apps/listing";
import { listFolders } from "@/lib/data/folders";
import { listProjects } from "@/lib/data/projects/read";
import { listEnvironmentsForProject } from "@/lib/data/environments";
import { listActivity } from "@/lib/data/activity";
import { listDatabases } from "@/lib/data/databases/rows";
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
import { AppsGrid } from "@/components/apps/apps-grid/apps-grid";
import { FolderTrail } from "@/components/apps/apps-grid/folder-trail";
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
import { welcomePending } from "@/lib/data/instance-owner";
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
    takeover: takeoverParam,
  } = await props.searchParams;
  const takenOverFrom = Array.isArray(takeoverParam)
    ? takeoverParam[0]
    : takeoverParam;
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
    firstRun,
  ] = await Promise.all([
    listApps(),
    listFolders(),
    listProjects(),
    listActivity(6),
    reachesWholeTeam(),
    isInstanceAdmin(),
    hasCapability("manage_team"),
    hasCapabilityAnywhere("create_apps"),
    hasCapability("create_databases"),
    hasCapability("create_folders"),
    hasCapability("create_projects"),
    hasCapabilityAnywhere("move_apps"),
    welcomePending(),
  ]);
  const activityDatabases = teamWideReach ? await listDatabases() : [];
  const networkSweepFailed = await networkSweepFailures();
  const canManageOrder = isAdmin || canManageTeam;
  const noCreateAppsNote =
    "You don't have permission to create apps. Ask a team admin for the “Create apps” permission.";
  const canManageAllFolders = canManageOrder;

  const openFolder =
    !query && folderId
      ? (folders.find((f) => f.id === folderId) ?? null)
      : null;
  const openProject =
    !query && !openFolder && projectId
      ? (projects.find((p) => p.id === projectId) ?? null)
      : null;

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
              (p.environmentId ?? defaultEnv?.id) === selectedEnv?.id,
          )
        : services.filter((p) => !p.folderId && !p.projectId);
  const visibleFolders = query
    ? []
    : openFolder
      ? folders.filter((f) => (f.parentId ?? null) === openFolder.id)
      : openProject
        ? []
        : folders.filter((f) => (f.parentId ?? null) === null);
  const visibleProjects = query || openFolder || openProject ? [] : projects;

  const enrichedFolders = await Promise.all(
    visibleFolders.map(async (f) => ({
      ...f,
      capabilities: await folderCapabilities(f.id),
      isOwner: await folderIsOwnerOrAdmin(f.id),
    })),
  );

  const enrichedProjects = await Promise.all(
    visibleProjects.map(async (p) => ({
      ...p,
      capabilities: await nodeCapabilities({ kind: "project", id: p.id }),
    })),
  );

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
  const trailPath = openProject
    ? [
        {
          id: openProject.id,
          name: openProject.name,
          href: projectHref(openProject.id, view),
        },
      ]
    : folderPath;

  const placement: OverviewPlacement | null = openFolder
    ? { folderId: openFolder.id }
    : openProject
      ? { projectId: openProject.id, environmentId: selectedEnv?.id ?? null }
      : null;

  const allFolders = folders.map((f) => ({ id: f.id, name: f.name }));
  const allAppIds = services.map((p) => p.id);

  const canReorder = canManageOrder && !query;

  const nothingToShow =
    visibleApps.length === 0 &&
    visibleFolders.length === 0 &&
    visibleProjects.length === 0;
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
    <div className="grid gap-6 3xl:grid-cols-[minmax(0,1fr)_300px]">
      <WelcomeCelebration
        show={welcome === "1" || firstRun}
        takeoverOf={takenOverFrom?.slice(0, 40) || null}
      />
      {canDeploy && (
        <ArchiveDropZone href={newAppHref(placement, { source: "upload" })} />
      )}
      <div className="relative z-20 order-2 hidden space-y-6 3xl:block">
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

      <div className="order-1 space-y-5">
        <PageHeader
          title="Overview"
          actions={
            <AddNewMenu
              canCreateApp={canDeploy}
              canCreateDatabase={canCreateDatabase}
              canCreateFolder={canCreateFolder}
              canCreateProject={canCreateProject}
              parentFolder={
                openFolder ? { id: openFolder.id, name: openFolder.name } : null
              }
              placement={placement}
            />
          }
        />

        {isAdmin && (
          <NetworkSweepNotice failed={networkSweepFailed} canRetry={isAdmin} />
        )}

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
