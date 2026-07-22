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
  Boxes,
} from "lucide-react";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { describeAppSource } from "@/components/apps/app-source";
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
import { Button } from "@/components/ui/button";
import { MenuSubTooltip, SimpleTooltip } from "@/components/ui/tooltip";
import { AppLogo } from "@/components/shared/project-logo";
import {
  AppLiveStatusProvider,
  useLiveStatus,
} from "@/components/apps/app-live-status";
import { AppStatusDot } from "@/components/apps/app-status-dot";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { appTypeLabel, cn, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { AppSummary } from "@/lib/data/apps";
import type { AppStatus } from "@/lib/types";

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

/**
 * The card's status dot on the LIVE path the app header uses: an
 * {@link AppLiveStatusProvider} seeded from the server-rendered summary feeds
 * {@link AppStatusDot}, which folds the appStatus subscription with the agent
 * runtime poll — mirroring DatabaseCard's DatabaseStatusDot, so the Overview
 * never shows a stale green for a container that crashed or was stopped
 * outside deplo.
 */
function LiveCardStatusDot({ project }: { project: AppSummary }) {
  return (
    <AppLiveStatusProvider
      initial={{
        id: project.id,
        slug: project.slug,
        status: project.status,
        productionUrl: project.productionUrl,
        latestDeploymentId: project.latestDeployment?.id ?? null,
        latestDeploymentStatus: project.latestDeployment?.status ?? null,
      }}
    >
      <LiveCardDotInner fallback={project.status} />
    </AppLiveStatusProvider>
  );
}

/** Inside the provider: the dot plus a hover word that tracks the LIVE status
 *  (the dot's colour carries the state; this only spells it out on hover). */
function LiveCardDotInner({ fallback }: { fallback: AppStatus }) {
  const status = useLiveStatus(fallback);
  const statusLabel =
    status === "idle"
      ? "Stopped"
      : status === "active"
        ? "Running"
        : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span title={statusLabel} className="inline-flex items-center">
      <AppStatusDot status={status} />
    </span>
  );
}

export function AppCard({
  project,
  view = "grid",
  dragHandle,
  dragActive = false,
  folders,
  canManageFolders = false,
  environments,
}: {
  project: AppSummary;
  view?: "grid" | "list";
  /** Optional drag-to-reorder handle, rendered with the card's controls. */
  dragHandle?: React.ReactNode;
  /**
   * A reorder drag is in progress for the grid. While on, the card's stretched
   * navigation link is made inert so the whole card can be dragged without
   * navigating away on release. (Reordering is purely drag-bound — there is no
   * lingering "edit" mode; it ends the instant the drag does.)
   */
  dragActive?: boolean;
  /** Team folders, for the "Move to folder" menu (omitted ⇒ no folders). */
  folders?: { id: string; name: string }[];
  /** Whether the viewer may move this app between folders. */
  canManageFolders?: boolean;
  /** The surrounding project's environments, for the "Move to environment"
   *  menu (ADR-0009). Only passed inside a project drill-in view; omitted ⇒
   *  the menu is hidden. The caller gates it on the `deploy` capability. */
  environments?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const dep = project.latestDeployment;
  // A repo ⇒ a git deploy (real branch + repo). Otherwise the app has no
  // git, so we describe its source instead of inventing a branch. Shared with
  // the app overview page so the two never disagree (see app-source.tsx).
  const nonGit = project.repo ? null : describeAppSource(project);

  // The card mirrors the app header's lifecycle controls in a minimized
  // form: Start/Stop track the persisted status (no live subscription on the
  // overview, so a refresh after each action keeps the menu in sync).
  const stopped = project.status === "idle";
  const stopping = project.status === "stopping";

  // Clicking anywhere on the card opens the app overview. The latest commit
  // is shown on the card itself (compact) rather than deep-linking to it.
  const href = `/apps/${project.slug}`;

  function redeploy() {
    startTransition(async () => {
      const res = await gqlAction<
        { redeploy: { id: string | null } | null },
        { id: string | null } | null
      >(
        `mutation($appId: String!) { redeploy(appId: $appId) { id } }`,
        { appId: project.id },
        (d) => d.redeploy,
      );
      if (res.ok) {
        toast.success(`Redeploying ${project.name}…`);
        // Follow the new build straight to its live logs; fall back to a refresh
        // if no id came back.
        if (res.data?.id) {
          router.push(`/apps/${project.slug}/deployments/${res.data.id}`);
        } else {
          router.refresh();
        }
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
      const res = await gqlAction<{ reloadApp: string | null }, string>(
        `mutation($id: String!) { reloadApp(id: $id) }`,
        { id: project.id },
        (d) => d.reloadApp ?? "",
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

  // Move this app into a folder, or back to the top level (folderId null).
  // The grid also supports dragging a card onto a folder; this menu is the
  // keyboard-friendly, always-available counterpart.
  function moveTo(folderId: string | null) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($appId: ID!, $folderId: ID) { moveAppToFolder(appId: $appId, folderId: $folderId) }`,
        { appId: project.id, folderId },
      );
      if (res.ok) {
        toast.success(folderId ? "Moved to folder" : "Moved out of folder");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // Move this app to another environment of its project (ADR-0009: each
  // environment holds its own apps), or out of the project entirely.
  function moveToEnvironment(environmentId: string | null) {
    startTransition(async () => {
      const res = environmentId
        ? await gqlAction(
            `mutation($appId: ID!, $environmentId: ID!) { moveAppToEnvironment(appId: $appId, environmentId: $environmentId) }`,
            { appId: project.id, environmentId },
          )
        : await gqlAction(
            `mutation($appId: ID!) { moveAppToProject(appId: $appId) }`,
            { appId: project.id },
          );
      if (res.ok) {
        toast.success(
          environmentId ? "Moved to environment" : "Moved out of project",
        );
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
        <SimpleTooltip
          content="The container is currently stopping"
          side="left"
        >
          <K.Item disabled>
            <Loader2 className="size-4 animate-spin" />
            Stopping…
          </K.Item>
        </SimpleTooltip>
      ) : stopped ? (
        <SimpleTooltip
          content="Start this app's stopped container"
          side="left"
        >
          <K.Item
            onSelect={() =>
              act(
                `mutation($id: String!) { startApp(id: $id) { id } }`,
                "Container started",
              )
            }
            disabled={pending}
          >
            <Play className="size-4" />
            Start
          </K.Item>
        </SimpleTooltip>
      ) : (
        <SimpleTooltip
          content="Stop this app's running container"
          side="left"
        >
          <K.Item
            onSelect={() =>
              act(
                `mutation($id: String!) { stopApp(id: $id) { id } }`,
                "Container stopped",
              )
            }
            disabled={pending}
          >
            <Square className="size-4" />
            Stop
          </K.Item>
        </SimpleTooltip>
      )}
      <SimpleTooltip
        content="Re-apply domains and basic auth to the running container — no rebuild"
        side="left"
      >
        <K.Item onSelect={reload} disabled={pending}>
          <RefreshCw className="size-4" />
          Reload
        </K.Item>
      </SimpleTooltip>
      <SimpleTooltip
        content="Redeploy the latest successful build"
        side="left"
      >
        <K.Item onSelect={redeploy} disabled={pending}>
          <RotateCw className="size-4" />
          Redeploy
        </K.Item>
      </SimpleTooltip>
      <K.Separator />
      <SimpleTooltip
        content="Open this app's overview and deployments"
        side="left"
      >
        <K.Item asChild>
          <Link href={href} className="cursor-pointer">
            <Activity className="size-4" />
            View deployments
          </Link>
        </K.Item>
      </SimpleTooltip>
      <SimpleTooltip content="Open this app's settings" side="left">
        <K.Item asChild>
          <Link href={`${href}/settings`} className="cursor-pointer">
            <Settings className="size-4" />
            Settings
          </Link>
        </K.Item>
      </SimpleTooltip>
      {canManageFolders && folders && folders.length > 0 && (
        <MenuSubTooltip
          Sub={K.Sub}
          SubTrigger={K.SubTrigger}
          SubContent={K.SubContent}
          content="Move this app into a folder"
          subContentClassName="max-h-72 overflow-y-auto"
          trigger={
            <>
              <FolderInput className="size-4" />
              Move to folder
            </>
          }
        >
          {project.folderId && (
            <>
              <SimpleTooltip
                content="Move back to the top level (ungrouped)"
                side="left"
              >
                <K.Item onSelect={() => moveTo(null)} disabled={pending}>
                  Ungrouped
                </K.Item>
              </SimpleTooltip>
              <K.Separator />
            </>
          )}
          {folders.map((f) => (
            <SimpleTooltip
              key={f.id}
              content={`Move into ${f.name}`}
              side="left"
            >
              <K.Item
                onSelect={() => moveTo(f.id)}
                disabled={pending || f.id === project.folderId}
              >
                {f.name}
              </K.Item>
            </SimpleTooltip>
          ))}
        </MenuSubTooltip>
      )}
      {environments && environments.length > 0 && (
        <MenuSubTooltip
          Sub={K.Sub}
          SubTrigger={K.SubTrigger}
          SubContent={K.SubContent}
          content="Move this app to another environment of this project"
          subContentClassName="max-h-72 overflow-y-auto"
          trigger={
            <>
              <Boxes className="size-4" />
              Move to environment
            </>
          }
        >
          {environments.map((e) => (
            <SimpleTooltip
              key={e.id}
              content={`Move to ${e.name}`}
              side="left"
            >
              <K.Item
                onSelect={() => moveToEnvironment(e.id)}
                disabled={pending || e.id === project.environmentId}
              >
                {e.name}
              </K.Item>
            </SimpleTooltip>
          ))}
          {project.projectId && (
            <>
              <K.Separator />
              <SimpleTooltip
                content="Move back to the Overview top level, out of this project"
                side="left"
              >
                <K.Item
                  onSelect={() => moveToEnvironment(null)}
                  disabled={pending}
                >
                  Out of project
                </K.Item>
              </SimpleTooltip>
            </>
          )}
        </MenuSubTooltip>
      )}
      <K.Separator />
      <SimpleTooltip
        content="Permanently delete this app and its deployments"
        side="left"
      >
        <K.Item variant="destructive" onSelect={() => setConfirmOpen(true)}>
          <Trash2 className="size-4" />
          Delete
        </K.Item>
      </SimpleTooltip>
    </>
  );

  // Shared interactive controls (status dot + drag handle + ⋯ menu). Used by
  // both layouts. At rest the status dot sits flush against the ⋯; the drag
  // handle is zero-width until hover, when it expands and slides the dot left.
  const actions = (
    <div className="pointer-events-auto relative z-10 flex items-center gap-1">
      {/* App status as a bare dot (green / amber / red / grey), no label —
          the dot's colour is the status; hovering it shows the word. Folded
          LIVE (status subscription + runtime poll), never the stored status,
          so a crashed or externally-stopped app can't sit green here. */}
      <LiveCardStatusDot project={project} />
      {/* Drag handle is taken out of the flow at rest (display:none) so it
          leaves no empty gap; it appears on hover / keyboard focus. The row's
          single gap-1 then spaces all three icons identically. Going from
          display:none → flex restarts the enter animation, so the handle slides
          + fades in each time it reveals. */}
      <span className="hidden items-center animate-in fade-in-0 slide-in-from-right-2 duration-200 group-hover:flex focus-within:flex">
        {dragHandle}
      </span>
      <div
        data-card-actions
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="App menu">
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
      targetKind="service"
      targetId={project.id}
      targetName={project.name}
      title={`Delete ${project.name}?`}
      description="This permanently removes the app, its deployments, domains and environment variables. This action cannot be undone."
      confirmLabel="Delete app"
      successMessage="App deleted"
      deleteMutation={() =>
        gqlAction(`mutation($id: String!) { deleteApp(id: $id) }`, {
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

  // The app's source identity (repo or "Compose"/image/upload), shown in the
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
        className="group relative flex items-center gap-4 p-4 transition-colors hover:border-foreground/20"
      >
        {overlayLink}
        <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-4">
          <AppLogo logo={project.logo} size={36} />
          <div className="min-w-0 flex-1">
            <span className="block truncate font-medium">{project.name}</span>
            {/* Same subtitle slot the app's own header uses: the live URL when
                a domain is linked, otherwise what this App *is* — "No domain
                yet" only restated the absence the empty slot already showed. */}
            <p className="truncate text-xs text-muted-foreground">
              {project.productionUrl
                ? project.productionUrl.replace(/^https?:\/\//, "")
                : appTypeLabel(project)}
            </p>
          </div>

          {dep ? (
            <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
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
        className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20"
      >
        {/* Stretched link: the whole card is clickable. Interactive controls
            below opt back into pointer events and sit above this overlay. */}
        {overlayLink}

        <div className="pointer-events-none relative z-[1] flex flex-1 flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <AppLogo logo={project.logo} size={36} />
              <div className="min-w-0 flex-1">
                <span className="block truncate font-medium">{project.name}</span>
                {/* See the list view above: URL when there is one, else the
                    App's kind, exactly as its management header reads. */}
                <p className="truncate text-xs text-muted-foreground">
                  {project.productionUrl
                    ? project.productionUrl.replace(/^https?:\/\//, "")
                    : appTypeLabel(project)}
                </p>
              </div>
            </div>

            {actions}
          </div>

          {/* Latest deployment */}
          {dep ? (
            <div className="rounded-lg border border-border bg-secondary/40 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {/* Non-git deploys (compose / image / upload) have no commit
                    SHA; render it only when present so an empty <code> + gap
                    doesn't leave a blank space before the commit message. */}
                {dep.commitSha && (
                  <code className="shrink-0 font-mono text-foreground">
                    {dep.commitSha.slice(0, 7)}
                  </code>
                )}
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

  return cardInner;
}
