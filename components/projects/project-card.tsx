"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  MoreHorizontal,
  GitBranch,
  RotateCw,
  ExternalLink,
  Settings,
  Trash2,
  Activity,
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
import { FrameworkIcon } from "@/components/shared/framework-icon";
import { StatusDot } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { timeAgo } from "@/lib/utils";
import { redeployAction, deleteProjectAction } from "@/lib/actions/projects";
import type { ProjectSummary } from "@/lib/data/projects";

export function ProjectCard({
  project,
  view = "grid",
}: {
  project: ProjectSummary;
  view?: "grid" | "list";
}) {
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const dep = project.latestDeployment;

  // Clicking anywhere on the card opens the project overview. The latest commit
  // is shown on the card itself (compact) rather than deep-linking to it.
  const href = `/projects/${project.slug}`;

  function redeploy() {
    startTransition(async () => {
      const res = await redeployAction(project.id);
      if (res.ok) toast.success(`Redeploying ${project.name}…`);
      else toast.error(res.error);
    });
  }

  // Shared interactive controls (external link + menu). Used by both layouts.
  const actions = (
    <div className="pointer-events-auto relative z-10 flex items-center gap-1">
      {project.productionUrl && (
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
        >
          <a
            href={project.productionUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open production URL"
          >
            <ExternalLink className="size-4" />
          </a>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Project menu">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={redeploy} disabled={pending}>
            <RotateCw className="size-4" />
            Redeploy
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/projects/${project.slug}`} className="cursor-pointer">
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
  );

  const confirm = (
    <ConfirmAction
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      title={`Delete ${project.name}?`}
      description="This permanently removes the project, its deployments, domains and environment variables. This action cannot be undone."
      confirmLabel="Delete project"
      successMessage="Project deleted"
      onConfirm={() => deleteProjectAction(project.id)}
    />
  );

  if (view === "list") {
    return (
      <Card className="group relative flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
        <Link
          href={href}
          aria-label={`Open ${project.name}`}
          className="absolute inset-0 z-0 cursor-pointer rounded-xl"
        />
        <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-4">
          <FrameworkIcon framework={project.framework} size={36} />
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
              <span className="whitespace-nowrap">{timeAgo(dep.createdAt)}</span>
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
      <Link
        href={href}
        aria-label={`Open ${project.name}`}
        className="absolute inset-0 z-0 cursor-pointer rounded-xl"
      />

      <div className="pointer-events-none relative z-[1] flex flex-1 flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <FrameworkIcon framework={project.framework} size={36} />
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
              <span className="min-w-0 flex-1 truncate">{dep.commitMessage}</span>
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
