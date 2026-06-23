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
  Hammer,
  Loader2,
} from "lucide-react";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ProjectLogo } from "@/components/shared/project-logo";
import { StatusDot } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { cn, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { ProjectSummary } from "@/lib/data/projects";

export function ProjectCard({
  project,
  view = "grid",
  dragHandle,
  editMode = false,
}: {
  project: ProjectSummary;
  view?: "grid" | "list";
  /** Optional drag-to-reorder handle, rendered with the card's controls. */
  dragHandle?: React.ReactNode;
  /**
   * Reorder ("jiggle") mode is active for the grid. While on, the card's
   * stretched navigation link is disabled so the whole card can be dragged
   * without navigating away on release.
   */
  editMode?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const dep = project.latestDeployment;

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

  // Lifecycle verbs (start/stop/rebuild) all take a single `id` argument and
  // share the same optimistic-refresh shape.
  function act(mutation: string, success: string) {
    startTransition(async () => {
      const res = await gqlAction(mutation, { id: project.id });
      if (res.ok) {
        toast.success(success);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // Shared interactive controls (drag handle + menu). Used by both layouts. The
  // keyboard drag handle stays outside `data-card-actions` so a pointer press on
  // it still bubbles to the card and starts a drag. The menu is wrapped in
  // `data-card-actions`, whose stopPropagation (across pointer/mouse/touch) keeps
  // a press there from starting a drag, and which the grid's click interception
  // spares so the menu keeps working in edit mode.
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
          <DropdownMenuContent align="end" className="w-48">
            {stopping ? (
              <DropdownMenuItem disabled>
                <Loader2 className="size-4 animate-spin" />
                Stopping…
              </DropdownMenuItem>
            ) : stopped ? (
              <DropdownMenuItem
                onClick={() =>
                  act(
                    `mutation($id: String!) { startProject(id: $id) { id } }`,
                    "Container started",
                  )
                }
                disabled={pending}
              >
                <Play className="size-4" />
                Start
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onClick={() =>
                  act(
                    `mutation($id: String!) { stopProject(id: $id) { id } }`,
                    "Container stopped",
                  )
                }
                disabled={pending}
              >
                <Square className="size-4" />
                Stop
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() =>
                act(
                  `mutation($id: String!) { rebuildProject(id: $id) { id } }`,
                  "Rebuild started",
                )
              }
              disabled={pending}
            >
              <Hammer className="size-4" />
              Rebuild
            </DropdownMenuItem>
            <DropdownMenuItem onClick={redeploy} disabled={pending}>
              <RotateCw className="size-4" />
              Redeploy
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                href={`/projects/${project.slug}`}
                className="cursor-pointer"
              >
                <Activity className="size-4" />
                View deployments
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link
                href={`/projects/${project.slug}/settings`}
                className="cursor-pointer"
              >
                <Settings className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(e) => {
                e.preventDefault();
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  const confirm = (
    <ConfirmAction
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      title={`Delete ${project.name}?`}
      description="This permanently removes the project, its deployments, domains and environment variables. This action cannot be undone."
      confirmLabel="Delete project"
      successMessage="Project deleted"
      onConfirm={async () => {
        const res = await gqlAction(
          `mutation($id: String!) { deleteProject(id: $id) }`,
          { id: project.id },
        );
        if (res.ok) router.push("/");
        return res;
      }}
    />
  );

  // Stretched, whole-card navigation link. In reorder (edit) mode it is made
  // inert — no pointer events, not focusable — so dragging the card never
  // navigates and keyboard users can't fall through to it while reordering.
  const overlayLink = (
    <Link
      href={href}
      aria-label={`Open ${project.name}`}
      tabIndex={editMode ? -1 : undefined}
      aria-hidden={editMode || undefined}
      className={cn(
        "absolute inset-0 z-0 rounded-xl",
        editMode ? "pointer-events-none cursor-default" : "cursor-pointer",
      )}
    />
  );

  if (view === "list") {
    return (
      <Card className="group relative flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
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
              <span className="text-muted-foreground/40">on</span>
              <GitBranch className="size-3 shrink-0" />
              <span className="max-w-32 truncate">{dep.branch}</span>
            </div>
          ) : (
            <span className="hidden whitespace-nowrap text-xs text-muted-foreground md:inline">
              No deployments yet
            </span>
          )}

          {project.repo && (
            <div className="hidden max-w-48 items-center gap-1.5 text-xs text-muted-foreground lg:flex">
              <GitHubIcon className="size-3.5 shrink-0" />
              <span className="truncate">{project.repo.repo}</span>
            </div>
          )}
        </div>

        {actions}
        {confirm}
      </Card>
    );
  }

  return (
    <Card className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20">
      {/* Stretched link: the whole card is clickable. Interactive controls below
          opt back into pointer events and sit above this overlay. */}
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
              <span>{timeAgo(dep.createdAt)}</span>
              <span className="text-muted-foreground/40">on</span>
              <GitBranch className="size-3" />
              <span>{dep.branch}</span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
            No deployments yet
          </div>
        )}

        {project.repo && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitHubIcon className="size-3.5" />
            <span className="truncate">{project.repo.repo}</span>
          </div>
        )}
      </div>

      {confirm}
    </Card>
  );
}
