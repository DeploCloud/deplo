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
import { listServices } from "@/lib/data/services";
import { listFolders } from "@/lib/data/folders";
import { listProjects } from "@/lib/data/projects";
import { listEnvironmentsForProject } from "@/lib/data/environments";
import { listProjectEnvironmentEnv } from "@/lib/data/environment-env";
import { listActivity } from "@/lib/data/activity";
import { isInstanceAdmin, hasCapability } from "@/lib/membership";
import {
  folderCapabilities,
  folderIsOwnerOrAdmin,
} from "@/lib/data/folder-access";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { ServicesGrid, FolderTrail } from "@/components/services/services-grid";
import { ServiceSearch } from "@/components/services/service-search";
import { EnvironmentSwitcher } from "@/components/services/environment-switcher";
import { projectHref } from "@/lib/overview-links";
import { EnvironmentManager } from "@/components/services/environment-manager";
import { EnvironmentEnvManager } from "@/components/env/environment-env-manager";
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
    canManageEnv,
  ] = await Promise.all([
    listServices(),
    listFolders(),
    listProjects(),
    listActivity(6),
    isInstanceAdmin(),
    hasCapability("manage_team"),
    hasCapability("manage_members"),
    hasCapability("deploy"),
    hasCapability("manage_env"),
  ]);
  const canManageOrder = isAdmin || canManageTeam;
  // Creating a folder or a project container is gated the same as creating a
  // service: any `deploy` holder (or an instance admin) may do it — NOT the
  // manage_team super-user gate.
  const canCreateFolder = isAdmin || canDeploy;
  // Team-wide bulk/reorder actions (and the manage menu on folders one doesn't
  // own) stay on the super-user flag; aliased for clarity at the call sites.
  const canManageAllFolders = canManageOrder;

  // What the grid shows:
  //  - searching: every matching service, flat, across all folders and projects
  //    (folders/projects hidden) so anything nested is still findable;
  //  - a folder open: that folder's direct services + its child folders;
  //  - a project open: the services of the SELECTED ENVIRONMENT (ADR-0009 —
  //    each environment is a sub-folder of services, picked via the dropdown),
  //    plus that environment's shared variables below the grid;
  //  - otherwise (top level): projects, top-level folders, ungrouped services.
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

  const visibleServices = query
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

  // The SELECTED environment's shared variables render below the grid (ADR-0009:
  // scoped to that environment only). Values are gated by manage_env, so skip
  // the (throwing) read without it.
  const envVarGroups =
    openProject && canManageEnv
      ? (await listProjectEnvironmentEnv(openProject.id)).filter(
          (g) => g.environmentId === selectedEnv?.id,
        )
      : [];

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

  const allFolders = folders.map((f) => ({ id: f.id, name: f.name }));
  const allServiceIds = services.map((p) => p.id);

  // Drag-to-reorder writes a team-wide order, so it is gated on permission; it is
  // also disabled mid-search (reordering a filtered list would persist a partial
  // order). When off, the grid renders statically.
  const canReorder = canManageOrder && !query;

  const nothingToShow =
    visibleServices.length === 0 &&
    visibleFolders.length === 0 &&
    visibleProjects.length === 0;
  // Re-seed the grid's optimistic state only on a structural change (navigation,
  // search, add/remove of a service, folder or project) — never on a pure
  // reorder/move, so a drag survives its own drop. See ServicesGrid.
  const gridKey = [
    view,
    query,
    openFolder?.id ?? "",
    openProject?.id ?? "",
    selectedEnv?.id ?? "",
    [...allServiceIds].sort().join(","),
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

      {/* Overview: projects, folders and services */}
      <div className="order-1 space-y-5 lg:order-1">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <AddNewMenu
            canManageMembers={canManageMembers}
            canCreateFolder={canCreateFolder}
            isAdmin={isAdmin}
          />
        </div>

        <ServiceSearch
          initialQuery={query}
          initialView={view}
          initialFolder={openFolder?.id ?? ""}
          initialProject={openProject?.id ?? ""}
          initialEnv={openProject && selectedEnv ? selectedEnv.id : ""}
        />

        {/* The project drill-in's environment dropdown (ADR-0009): each
            environment holds its own services, like a sub-folder. */}
        {openProject && selectedEnv && (
          <div className="flex items-center justify-end gap-2 px-1">
            <span className="text-sm text-muted-foreground">Environment</span>
            <EnvironmentSwitcher
              projectId={openProject.id}
              view={view}
              environments={environments.map((e) => ({
                id: e.id,
                name: e.name,
                isDefault: e.isDefault,
              }))}
              selectedId={selectedEnv.id}
            />
          </div>
        )}

        {nothingToShow ? (
          query ? (
            <EmptyState
              icon={Rocket}
              title="No services match your search"
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
                description="Drag services onto this folder from the Overview, or use a service’s “Move to folder” menu."
                action={
                  <Button asChild variant="outline">
                    <Link href={view === "list" ? "/?view=list" : "/"}>
                      Back to overview
                    </Link>
                  </Button>
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
                    ? `No services in ${selectedEnv.name}`
                    : `${openProject.name} is empty`
                }
                description="Drag services onto this project's card from the Overview (they land in the default environment), or use a service's “Move to environment” menu."
                action={
                  <Button asChild variant="outline">
                    <Link href={view === "list" ? "/?view=list" : "/"}>
                      Back to overview
                    </Link>
                  </Button>
                }
              />
            </div>
          ) : (
            <EmptyState
              icon={Rocket}
              title="No services yet"
              description="Import a Git repository or start from a template to deploy your first app."
              action={
                <div className="flex gap-2">
                  <Button asChild>
                    <Link href="/new">
                      <Plus className="size-4" />
                      Import Service
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
          <ServicesGrid
            key={gridKey}
            services={visibleServices}
            allServiceIds={allServiceIds}
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

        {/* The selected environment's shared variables + the project's
            environment management — the former /projects/<slug> detail page,
            folded into the Overview so projects never need a page of their own. */}
        {openProject && (
          <div className="space-y-6 pt-2">
            {canManageEnv && selectedEnv && (
              <section className="space-y-3">
                <div>
                  <h2 className="text-sm font-medium text-muted-foreground">
                    Shared variables — {selectedEnv.name}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Injected into every service of the {selectedEnv.name}{" "}
                    environment, and ONLY there. A service&apos;s own variable
                    with the same key overrides them.
                  </p>
                </div>
                <EnvironmentEnvManager groups={envVarGroups} canManage />
              </section>
            )}
            <EnvironmentManager
              projectId={openProject.id}
              canManage={canDeploy || isAdmin}
              environments={environments.map((e) => ({
                id: e.id,
                name: e.name,
                slug: e.slug,
                kind: e.kind,
                gitBranch: e.gitBranch,
                isDefault: e.isDefault,
              }))}
            />
          </div>
        )}
      </div>
    </div>
  );
}
