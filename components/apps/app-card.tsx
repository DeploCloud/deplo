"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  MoreHorizontal,
  GitBranch,
  RotateCw,
  Rocket,
  Settings,
  Trash2,
  Activity,
  Play,
  Square,
  RefreshCw,
  Loader2,
  FolderInput,
  Boxes,
  TriangleAlert,
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
import { AppStatusIndicator } from "@/components/apps/app-status-dot/status-renderer";
import type { OverviewAppStateView } from "./apps-grid/overview-state";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import {
  appTypeLabel,
  cn,
  repoCredentialMissing,
  timeAgoShort,
} from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { AppSummary } from "@/lib/data/apps/summary";
import type { Capability } from "@/lib/types/identity";

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

function LiveCardStatusDot({
  project,
  liveState,
}: {
  project: AppSummary;
  liveState?: OverviewAppStateView;
}) {
  const status = liveState?.status ?? project.status;
  const neverDeployed =
    liveState?.neverDeployed ??
    (project.status === "idle" && project.latestDeployment == null);
  const statusLabel = neverDeployed
    ? "Not deployed"
    : status === "idle"
      ? "Stopped"
      : status === "active"
        ? "Running"
        : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span title={statusLabel} className="inline-flex items-center">
      <AppStatusIndicator
        status={status}
        runtime={liveState?.runtime ?? null}
        neverDeployed={neverDeployed}
      />
    </span>
  );
}

export function AppCard({
  project,
  liveState,
  view = "grid",
  dragHandle,
  dragActive = false,
  folders,
  canMoveApps = false,
  environments,
  onDeleted,
  onMoved,
  onMoveFailed,
}: {
  project: AppSummary;
  liveState?: OverviewAppStateView;
  view?: "grid" | "list";
  dragHandle?: React.ReactNode;
  dragActive?: boolean;
  folders?: { id: string; name: string }[];
  canMoveApps?: boolean;
  environments?: { id: string; name: string }[];
  onDeleted?: () => void;
  onMoved?: () => void;
  onMoveFailed?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const dep = project.latestDeployment;
  const caps = project.capabilities;
  const can = (c: Capability) => !caps || caps.includes(c);
  const nonGit = project.repo ? null : describeAppSource(project);

  const stopped = project.status === "idle";
  const stopping = project.status === "stopping";
  const neverDeployed = stopped && !dep;
  const restoring = project.status === "restoring";

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
        toast.success(
          `${neverDeployed ? "Deploying" : "Redeploying"} ${project.name}`,
        );
        if (res.data?.id) {
          router.push(`/apps/${project.slug}/deployments/${res.data.id}`);
        } else {
          router.refresh();
        }
      } else toast.error(res.error);
    });
  }

  function act(mutation: string, success: string) {
    startTransition(async () => {
      const res = await gqlAction(mutation, { id: project.id });
      if (res.ok) {
        toast.success(success);
        router.refresh();
      } else toast.error(res.error);
    });
  }

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
            : "Saved - applies on the next deploy",
      );
      router.refresh();
    });
  }

  function moveTo(folderId: string | null) {
    onMoved?.();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($appId: ID!, $folderId: ID) { moveAppToFolder(appId: $appId, folderId: $folderId) }`,
        { appId: project.id, folderId },
      );
      if (res.ok)
        toast.success(folderId ? "Moved to folder" : "Moved out of folder");
      else {
        onMoveFailed?.();
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  function moveToEnvironment(environmentId: string | null) {
    onMoved?.();
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
      } else {
        onMoveFailed?.();
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  const menu = (K: MenuKit) => (
    <>
      {neverDeployed ? null : restoring ? (
        <SimpleTooltip
          content="A backup is being restored into this app"
          side="left"
        >
          <K.Item disabled>
            <Loader2 className="size-4 animate-spin" />
            Restoring
          </K.Item>
        </SimpleTooltip>
      ) : stopping ? (
        <SimpleTooltip
          content="The container is currently stopping"
          side="left"
        >
          <K.Item disabled>
            <Loader2 className="size-4 animate-spin" />
            Stopping
          </K.Item>
        </SimpleTooltip>
      ) : stopped ? (
        <SimpleTooltip content="Start this app's stopped container" side="left">
          <K.Item
            onSelect={() =>
              act(
                `mutation($id: String!) { startApp(id: $id) { id } }`,
                "Container started",
              )
            }
            disabled={!can("control_apps")}
          >
            <Play className="size-4" />
            Start
          </K.Item>
        </SimpleTooltip>
      ) : (
        <SimpleTooltip content="Stop this app's running container" side="left">
          <K.Item
            onSelect={() =>
              act(
                `mutation($id: String!) { stopApp(id: $id) { id } }`,
                "Container stopped",
              )
            }
            disabled={!can("control_apps")}
          >
            <Square className="size-4" />
            Stop
          </K.Item>
        </SimpleTooltip>
      )}
      {!neverDeployed && (
        <SimpleTooltip
          content="Re-apply domains and basic auth to the running container, no rebuild"
          side="left"
        >
          <K.Item onSelect={reload} disabled={!can("control_apps")}>
            <RefreshCw className="size-4" />
            Reload
          </K.Item>
        </SimpleTooltip>
      )}
      <SimpleTooltip
        content={
          neverDeployed
            ? "Build and start this app for the first time"
            : "Redeploy the latest successful build"
        }
        side="left"
      >
        <K.Item onSelect={redeploy} disabled={pending || !can("deploy_apps")}>
          {neverDeployed ? (
            <Rocket className="size-4" />
          ) : (
            <RotateCw className="size-4" />
          )}
          {neverDeployed ? "Deploy" : "Redeploy"}
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
      {canMoveApps && folders && folders.length > 0 && (
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
                <K.Item
                  onSelect={() => moveTo(null)}
                  disabled={!can("move_apps")}
                >
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
                disabled={!can("move_apps") || f.id === project.folderId}
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
            <SimpleTooltip key={e.id} content={`Move to ${e.name}`} side="left">
              <K.Item
                onSelect={() => moveToEnvironment(e.id)}
                disabled={!can("move_apps") || e.id === project.environmentId}
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
                  disabled={!can("move_apps")}
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
        <K.Item
          variant="destructive"
          onSelect={() => setConfirmOpen(true)}
          disabled={!can("delete_apps")}
        >
          <Trash2 className="size-4" />
          Delete
        </K.Item>
      </SimpleTooltip>
    </>
  );

  const actions = (
    <div className="pointer-events-auto relative z-10 flex items-center gap-1">
      <LiveCardStatusDot project={project} liveState={liveState} />
      <span className="hidden animate-in items-center duration-200 fade-in-0 slide-in-from-right-2 group-hover:flex focus-within:flex">
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
      targetKind="app"
      targetId={project.id}
      targetName={project.name}
      title="Delete app?"
      description={
        <>
          Deleting <strong>{project.name}</strong> removes it for good.
        </>
      }
      consequence="Its data, deployments, domains, variables and every backup it has stored go with it."
      confirmLabel="Delete app"
      successMessage="App deleted"
      deleteMutation={() =>
        gqlAction(`mutation($id: String!) { deleteApp(id: $id) }`, {
          id: project.id,
        })
      }
      onDeleted={() => {
        onDeleted?.();
        router.refresh();
      }}
    />
  );

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

  const identity = project.repo ? (
    <>
      <GitHubIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{project.repo.repo}</span>
      {repoCredentialMissing(project) && (
        <SimpleTooltip content="No GitHub App is linked - a private repository will not clone">
          <TriangleAlert className="pointer-events-auto size-3.5 shrink-0 text-[var(--warning)]" />
        </SimpleTooltip>
      )}
    </>
  ) : nonGit ? (
    <>
      <nonGit.Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{nonGit.label}</span>
    </>
  ) : null;

  const cardInner =
    view === "list" ? (
      <Card className="group relative flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
        {overlayLink}
        <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-4">
          <AppLogo logo={project.logo} tone={project.logoTone} size={36} />
          <div className="min-w-0 flex-1">
            <span className="block truncate font-medium">{project.name}</span>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {project.productionUrl
                ? project.productionUrl.replace(/^https?:\/\//, "")
                : appTypeLabel(project)}
            </p>
          </div>

          {dep ? (
            <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
              <span className="whitespace-nowrap">
                {timeAgoShort(dep.createdAt)}
              </span>
              {project.repo && (
                <>
                  <span className="text-muted-foreground/40">on</span>
                  <GitBranch className="size-3 shrink-0" />
                  <span className="max-w-32 truncate">{dep.branch}</span>
                </>
              )}
            </div>
          ) : (
            <span className="hidden text-xs whitespace-nowrap text-muted-foreground md:inline">
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
      <Card className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20">
        {overlayLink}

        <div className="pointer-events-none relative z-[1] flex flex-1 flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <AppLogo logo={project.logo} tone={project.logoTone} size={36} />
              <div className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {project.name}
                </span>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {project.productionUrl
                    ? project.productionUrl.replace(/^https?:\/\//, "")
                    : appTypeLabel(project)}
                </p>
              </div>
            </div>

            {actions}
          </div>

          {dep ? (
            <div className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
                <span className="shrink-0">{timeAgoShort(dep.createdAt)}</span>
                {project.repo ? (
                  <>
                    <span className="shrink-0 text-muted-foreground/40">
                      on
                    </span>
                    <GitBranch className="size-3 shrink-0" />
                    <span className="min-w-0 truncate">{dep.branch}</span>
                    <span className="shrink-0 text-muted-foreground/40">·</span>
                    {identity}
                  </>
                ) : (
                  identity && (
                    <>
                      <span className="shrink-0 text-muted-foreground/40">
                        ·
                      </span>
                      {identity}
                    </>
                  )
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              No deployments yet
              {identity && (
                <div className="mt-2 flex items-center gap-1.5">{identity}</div>
              )}
            </div>
          )}
        </div>

        {confirm}
      </Card>
    );

  if (project.migrationRunId)
    return (
      <div
        inert
        aria-busy
        title="This is still being brought over by a migration"
        className="pointer-events-none animate-pulse opacity-70 select-none"
      >
        {cardInner}
      </div>
    );

  return cardInner;
}
