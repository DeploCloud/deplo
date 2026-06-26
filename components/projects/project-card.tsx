"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  GitBranch,
  RotateCw,
  Settings,
  Trash2,
  Activity,
  Play,
  Square,
  RefreshCw,
  Loader2,
  FolderInput,
} from "lucide-react";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { describeProjectSource } from "@/components/projects/project-source";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { ProjectLogo } from "@/components/shared/project-logo";
import { StatusDot } from "@/components/shared/status-badge";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { cn, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { ProjectSummary } from "@/lib/data/projects";

/**
 * The menu-primitive set used to render the card's action list once and reuse it
 * for BOTH the ⋯ dropdown (left-click) and the right-click context menu — same
 * items, same handlers, no duplication. Radix dropdown and context menus share
 * an isomorphic API, so the renderer just takes whichever component set applies.
 */
type MenuKit = {
  Item: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
  Separator: React.ElementType;
};

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Separator: DropdownMenuSeparator,
};
const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Separator: ContextMenuSeparator,
};

export function ProjectCard({
  project,
  view = "grid",
  dragHandle,
  dragActive = false,
  folders,
  canManageFolders = false,
  contextMenuOverride,
}: {
  project: ProjectSummary;
  view?: "grid" | "list";
  /** Optional drag-to-reorder handle, rendered with the card's controls. */
  dragHandle?: React.ReactNode;
  /**
   * When this card is part of a multi-selection, the grid passes the shared
   * BULK-actions menu here; it replaces this card's own single-item right-click
   * menu so a right-click acts on the whole selection. Undefined ⇒ the normal
   * per-card menu.
   */
  contextMenuOverride?: React.ReactNode;
  /**
   * A reorder drag is in progress for the grid. While on, the card's stretched
   * navigation link is made inert so the whole card can be dragged without
   * navigating away on release. (Reordering is purely drag-bound — there is no
   * lingering "edit" mode; it ends the instant the drag does.)
   */
  dragActive?: boolean;
  /** Team folders, for the "Move to folder" menu (omitted ⇒ no folders). */
  folders?: { id: string; name: string }[];
  /** Whether the viewer may move this project between folders. */
  canManageFolders?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const dep = project.latestDeployment;
  // A repo ⇒ a git deploy (real branch + repo). Otherwise the project has no
  // git, so we describe its source instead of inventing a branch. Shared with
  // the project overview page so the two never disagree (see project-source.tsx).
  const nonGit = project.repo ? null : describeProjectSource(project);

  // The card mirrors the project header's lifecycle controls in a minimized
  // form: Start/Stop track the persisted status (no live subscription on the
  // overview, so a refresh after each action keeps the menu in sync).
  const stopped = project.status === "idle";
  const stopping = project.status === "stopping";

  // Clicking anywhere on the card opens the project overview. The latest commit
  // is shown on the card itself (compact) rather than deep-linking to it.
  const href = `/projects/${project.slug}`;

  function redeploy() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($projectId: String!) { redeploy(projectId: $projectId) { id } }`,
        { projectId: project.id },
      );
      if (res.ok) {
        toast.success(`Redeploying ${project.name}…`);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // Lifecycle verbs (start/stop) all take a single `id` argument and share the
  // same optimistic-refresh shape.
  function act(mutation: string, success: string) {
    startTransition(async () => {
      const res = await gqlAction(mutation, { id: project.id });
      if (res.ok) {
        toast.success(success);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // Reload re-applies routing (domains + basic auth) to the running container
  // with no rebuild; the mutation returns a status string we turn into a toast.
  function reload() {
    startTransition(async () => {
      const res = await gqlAction<{ reloadProject: string | null }, string>(
        `mutation($id: String!) { reloadProject(id: $id) }`,
        { id: project.id },
        (d) => d.reloadProject ?? "",
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        res.data === "rerouted"
          ? "Routing reloaded"
          : res.data === "unchanged"
            ? "Already up to date"
            : "Saved — applies on the next deploy",
      );
      router.refresh();
    });
  }

  // Move this project into a folder, or back to the top level (folderId null).
  // The grid also supports dragging a card onto a folder; this menu is the
  // keyboard-friendly, always-available counterpart.
  function moveTo(folderId: string | null) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($projectId: ID!, $folderId: ID) { moveProjectToFolder(projectId: $projectId, folderId: $folderId) }`,
        { projectId: project.id, folderId },
      );
      if (res.ok) {
        toast.success(folderId ? "Moved to folder" : "Moved out of folder");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // The card's actions, rendered once for whichever menu primitive is passed.
  // Each item carries a native `title` so hovering it for ~a second explains
  // what it does (reliable inside menus, unlike a nested styled tooltip).
  const menu = (K: MenuKit) => (
    <>
      {stopping ? (
        <K.Item disabled title="The container is currently stopping">
          <Loader2 className="size-4 animate-spin" />
          Stopping…
        </K.Item>
      ) : stopped ? (
        <K.Item
          onSelect={() =>
            act(
              `mutation($id: String!) { startProject(id: $id) { id } }`,
              "Container started",
            )
          }
          disabled={pending}
          title="Start this project's stopped container"
        >
          <Play className="size-4" />
          Start
        </K.Item>
      ) : (
        <K.Item
          onSelect={() =>
            act(
              `mutation($id: String!) { stopProject(id: $id) { id } }`,
              "Container stopped",
            )
          }
          disabled={pending}
          title="Stop this project's running container"
        >
          <Square className="size-4" />
          Stop
        </K.Item>
      )}
      <K.Item
        onSelect={reload}
        disabled={pending}
        title="Re-apply domains and basic auth to the running container — no rebuild"
      >
        <RefreshCw className="size-4" />
        Reload
      </K.Item>
      <K.Item
        onSelect={redeploy}
        disabled={pending}
        title="Redeploy the latest successful build"
      >
        <RotateCw className="size-4" />
        Redeploy
      </K.Item>
      <K.Separator />
      <K.Item asChild title="Open this project's overview and deployments">
        <Link href={href} className="cursor-pointer">
          <Activity className="size-4" />
          View deployments
        </Link>
      </K.Item>
      <K.Item asChild title="Open this project's settings">
        <Link href={`${href}/settings`} className="cursor-pointer">
          <Settings className="size-4" />
          Settings
        </Link>
      </K.Item>
      {canManageFolders && folders && folders.length > 0 && (
        <K.Sub>
          <K.SubTrigger title="Move this project into a folder">
            <FolderInput className="size-4" />
            Move to folder
          </K.SubTrigger>
          <K.SubContent className="max-h-72 overflow-y-auto">
            {project.folderId && (
              <>
                <K.Item
                  onSelect={() => moveTo(null)}
                  disabled={pending}
                  title="Move back to the top level (ungrouped)"
                >
                  Ungrouped
                </K.Item>
                <K.Separator />
              </>
            )}
            {folders.map((f) => (
              <K.Item
                key={f.id}
                onSelect={() => moveTo(f.id)}
                disabled={pending || f.id === project.folderId}
                title={`Move into ${f.name}`}
              >
                {f.name}
              </K.Item>
            ))}
          </K.SubContent>
        </K.Sub>
      )}
      <K.Separator />
      <K.Item
        variant="destructive"
        onSelect={(e: Event) => {
          e.preventDefault();
          setConfirmOpen(true);
        }}
        title="Permanently delete this project and its deployments"
      >
        <Trash2 className="size-4" />
        Delete
      </K.Item>
    </>
  );

  // Shared interactive controls (drag handle + ⋯ menu). Used by both layouts.
  const actions = (
    <div className="pointer-events-auto relative z-10 flex items-center gap-1">
      {dragHandle}
      <div
        data-card-actions
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Project menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {menu(DROPDOWN_KIT)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  const confirm = (
    <DeleteWithArtifacts
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      targetKind="project"
      targetId={project.id}
      targetName={project.name}
      title={`Delete ${project.name}?`}
      description="This permanently removes the project, its deployments, domains and environment variables. This action cannot be undone."
      confirmLabel="Delete project"
      successMessage="Project deleted"
      deleteMutation={() =>
        gqlAction(`mutation($id: String!) { deleteProject(id: $id) }`, {
          id: project.id,
        })
      }
      onDeleted={() => router.push("/")}
    />
  );

  // Stretched, whole-card navigation link. While a reorder drag is active it is
  // made inert — no pointer events, not focusable — so dragging the card never
  // navigates and keyboard users can't fall through to it while reordering.
  const overlayLink = (
    <Link
      href={href}
      aria-label={`Open ${project.name}`}
      tabIndex={dragActive ? -1 : undefined}
      aria-hidden={dragActive || undefined}
      className={cn(
        "absolute inset-0 z-0 rounded-xl",
        dragActive ? "pointer-events-none cursor-default" : "cursor-pointer",
      )}
    />
  );

  // The project's source identity (repo or "Compose"/image/upload), shown in the
  // deployment box when there's no deployment yet. Mirrors the list view so a
  // freshly imported git project still shows its repo before its first deploy.
  const identity = project.repo ? (
    <>
      <GitHubIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{project.repo.repo}</span>
    </>
  ) : nonGit ? (
    <>
      <nonGit.Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{nonGit.label}</span>
    </>
  ) : null;

  const cardInner =
    view === "list" ? (
      <Card
        onContextMenu={(e) => e.stopPropagation()}
        className="group relative flex items-center gap-4 p-4 transition-colors hover:border-foreground/20"
      >
        {overlayLink}
        <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-4">
          <ProjectLogo
            logo={project.logo}
            framework={project.framework}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <span className="truncate font-medium">{project.name}</span>
            {project.productionUrl ? (
              <p className="truncate text-xs text-muted-foreground">
                {project.productionUrl.replace(/^https?:\/\//, "")}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">No domain yet</p>
            )}
          </div>

          {dep ? (
            <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
              <StatusDot status={dep.status} />
              <span className="whitespace-nowrap">
                {timeAgo(dep.createdAt)}
              </span>
              {/* Branch only for a git deploy — compose/image/upload have none. */}
              {project.repo && (
                <>
                  <span className="text-muted-foreground/40">on</span>
                  <GitBranch className="size-3 shrink-0" />
                  <span className="max-w-32 truncate">{dep.branch}</span>
                </>
              )}
            </div>
          ) : (
            <span className="hidden whitespace-nowrap text-xs text-muted-foreground md:inline">
              No deployments yet
            </span>
          )}

          {identity && (
            <div className="hidden max-w-48 items-center gap-1.5 text-xs text-muted-foreground lg:flex">
              {identity}
            </div>
          )}
        </div>

        {actions}
        {confirm}
      </Card>
    ) : (
      <Card
        onContextMenu={(e) => e.stopPropagation()}
        className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20"
      >
        {/* Stretched link: the whole card is clickable. Interactive controls
            below opt back into pointer events and sit above this overlay. */}
        {overlayLink}

        <div className="pointer-events-none relative z-[1] flex flex-1 flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <ProjectLogo
                logo={project.logo}
                framework={project.framework}
                size={36}
              />
              <div className="min-w-0">
                <span className="truncate font-medium">{project.name}</span>
                {project.productionUrl ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {project.productionUrl.replace(/^https?:\/\//, "")}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">No domain yet</p>
                )}
              </div>
            </div>

            {actions}
          </div>

          {/* Latest deployment */}
          {dep ? (
            <div className="rounded-lg border border-border bg-secondary/40 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <StatusDot status={dep.status} />
                <code className="shrink-0 font-mono text-foreground">
                  {dep.commitSha.slice(0, 7)}
                </code>
                <span className="min-w-0 flex-1 truncate">
                  {dep.commitMessage}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="shrink-0">{timeAgo(dep.createdAt)}</span>
                {project.repo ? (
                  // Git deploy: real branch + repo on the same line.
                  <>
                    <span className="shrink-0 text-muted-foreground/40">on</span>
                    <GitBranch className="size-3 shrink-0" />
                    <span className="min-w-0 truncate">{dep.branch}</span>
                    <span className="shrink-0 text-muted-foreground/40">·</span>
                    {identity}
                  </>
                ) : (
                  // No git (compose / image / upload): no branch — show what the
                  // project IS (e.g. "Compose") where the repo would be.
                  identity && (
                    <>
                      <span className="shrink-0 text-muted-foreground/40">·</span>
                      {identity}
                    </>
                  )
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              No deployments yet
              {/* Even without a deployment, surface the repo/source identity so a
                  freshly-imported project still shows where it came from. */}
              {identity && (
                <div className="mt-2 flex items-center gap-1.5">{identity}</div>
              )}
            </div>
          )}
        </div>

        {confirm}
      </Card>
    );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{cardInner}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {contextMenuOverride ?? menu(CONTEXT_KIT)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
