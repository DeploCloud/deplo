"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter, useTeamSlug } from "@/lib/nav";
import { withTeam } from "@/lib/team-path";
import {
  GitBranch,
  GitPullRequest,
  Hammer,
  RotateCcwClock,
} from "lucide-react";
import { DeploymentCreator } from "@/components/apps/deployment-creator";
import { AppLogo } from "@/components/shared/project-logo";
import { Badge } from "@/components/ui/badge";
import { Bone } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/status-badge";
import { CommitLink } from "@/components/apps/commit-link";
import { DeploymentActions } from "@/components/apps/deployment-actions";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";
import { IN_PROGRESS } from "./deployment-status";
import type { CommitSignature, DeploymentStatus } from "@/lib/types/deployment";

const ROW_NAV_EXEMPT =
  'a, button, input, label, select, textarea, [role="checkbox"], [role="menuitem"], [data-no-row-nav]';

export interface DeploymentRow {
  id: string;
  appId: string;
  appSlug: string;
  serviceName: string;
  appLogo?: string | null;
  serverId?: string | null;
  serverName?: string | null;
  buildServerName?: string | null;
  commitMessage: string;
  commitSha: string;
  commitUrl: string | null;
  commitSignature?: CommitSignature | null;
  pullRequestUrl?: string | null;
  prNumber?: number | null;
  previewId?: string | null;
  status: DeploymentStatus;
  branch: string;
  createdAt: string;
  creator: string;
  creatorUser?: {
    name: string;
    username: string;
    avatarColor: string;
    avatarUrl: string | null;
  } | null;
  creatorProvider?: string | null;
  creatorUrl?: string | null;
  url: string;
  canRollback?: boolean;
  rollbackRebuilds?: boolean;
  rollbackOf?: string | null;
  appMigrating?: boolean;
}

export function useOpenDeployment() {
  const router = useRouter();
  const team = useTeamSlug();
  return function openDeployment(
    d: DeploymentRow,
    e: React.MouseEvent<HTMLTableRowElement>,
  ) {
    if ((e.target as HTMLElement | null)?.closest(ROW_NAV_EXEMPT)) return;
    if (window.getSelection()?.toString()) return;
    const href = `/apps/${d.appSlug}/deployments/${d.id}`;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) {
      window.open(withTeam(href, team), "_blank", "noopener,noreferrer");
      return;
    }
    router.push(href);
  };
}

export function DeploymentTableRow({
  d,
  showApp,
  showServer,
  canManage,
  canRollbackApps,
  checked,
  liveStatus,
  onOpen,
  onToggle,
  onRemoved,
  onRestored,
  loading = false,
}: {
  d: DeploymentRow;
  showApp: boolean;
  showServer: boolean;
  canManage: boolean;
  canRollbackApps: boolean;
  checked: boolean;
  liveStatus: DeploymentStatus;
  onOpen: (d: DeploymentRow, e: React.MouseEvent<HTMLTableRowElement>) => void;
  onToggle: (checked: boolean) => void;
  onRemoved: () => void;
  onRestored: () => void;
  loading?: boolean;
}) {
  const inProgress = IN_PROGRESS.has(d.status);
  return (
    <TableRow
      data-state={checked ? "selected" : undefined}
      // Below md a row is a two-line card: what and its status, then app, time and actions.
      className="cursor-pointer max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-1.5 max-md:px-4 max-md:py-3 max-md:[&>td]:p-0"
      onClick={(e) => onOpen(d, e)}
      onAuxClick={(e) => {
        if (e.button === 1) onOpen(d, e);
      }}
    >
      {canManage && (
        <TableCell data-no-row-nav className="max-md:hidden">
          <SimpleTooltip
            content={
              d.appMigrating
                ? "This app is still being brought over by a migration"
                : inProgress
                  ? "Cancel this build before it can be deleted"
                  : "Select for deletion"
            }
          >
            <span className="inline-flex">
              <Bone box loading={loading} className="rounded-sm">
                <Checkbox
                  checked={checked}
                  disabled={inProgress || d.appMigrating}
                  onCheckedChange={(v) => onToggle(v === true)}
                  aria-label={`Select deployment ${d.commitSha}`}
                />
              </Bone>
            </span>
          </SimpleTooltip>
        </TableCell>
      )}

      <TableCell className="max-w-[280px] max-md:order-1 max-md:w-[calc(100%-7rem)] max-md:max-w-none max-md:flex-none">
        <Link
          href={`/apps/${d.appSlug}/deployments/${d.id}`}
          className="block truncate font-medium text-foreground hover:underline focus-visible:underline"
        >
          <Bone loading={loading}>{d.commitMessage}</Bone>
        </Link>
        <span className="flex items-center gap-1.5">
          <Bone box loading={loading}>
            <CommitLink
              sha={d.commitSha}
              url={d.commitUrl}
              signature={d.commitSignature}
              className="font-mono text-xs text-muted-foreground"
            />
          </Bone>
          {d.prNumber ? (
            <SimpleTooltip content={`Built for pull request #${d.prNumber}`}>
              <Badge
                variant="outline"
                className="gap-1 px-1.5 py-0 text-xs font-normal"
              >
                <GitPullRequest className="size-3" />
                {d.prNumber}
              </Badge>
            </SimpleTooltip>
          ) : null}
          {d.rollbackOf ? (
            <SimpleTooltip content="This deployment put the app back on an earlier build">
              <Badge
                variant="outline"
                className="gap-1 px-1.5 py-0 text-xs font-normal"
              >
                <RotateCcwClock className="size-3" />
                Rollback
              </Badge>
            </SimpleTooltip>
          ) : null}
        </span>
      </TableCell>

      {showApp && (
        <TableCell className="max-md:order-3 max-md:min-w-0 max-md:flex-1 max-md:basis-[40%] max-md:text-sm">
          <SimpleTooltip content="Open this deployment's build logs">
            <Link
              href={`/apps/${d.appSlug}/deployments/${d.id}`}
              className="flex cursor-pointer items-center gap-2 font-medium text-foreground hover:underline"
            >
              <Bone box loading={loading} className="shrink-0">
                <AppLogo logo={d.appLogo ?? null} size={20} />
              </Bone>
              <span className="truncate">
                <Bone loading={loading}>{d.serviceName}</Bone>
              </span>
            </Link>
          </SimpleTooltip>
        </TableCell>
      )}

      {showServer && (
        <TableCell className="max-md:hidden">
          {d.serverName ? (
            <SimpleTooltip
              content={
                d.buildServerName
                  ? `Built on ${d.buildServerName}, then released here`
                  : `Built and released on ${d.serverName}`
              }
            >
              <span className="flex items-center gap-1.5 text-muted-foreground">
                {d.buildServerName && <Hammer className="size-3.5 shrink-0" />}
                <span className="truncate">
                  <Bone loading={loading}>{d.serverName}</Bone>
                </span>
              </span>
            </SimpleTooltip>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      )}

      <TableCell className="max-md:order-2">
        <Bone box loading={loading}>
          <StatusBadge status={liveStatus} />
        </Bone>
      </TableCell>

      <TableCell className="max-md:hidden">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate font-mono text-xs">
            <Bone loading={loading}>{d.branch}</Bone>
          </span>
        </span>
      </TableCell>

      <TableCell className="max-md:order-4 max-md:text-sm max-md:text-muted-foreground">
        <p className="whitespace-nowrap text-foreground max-md:text-muted-foreground">
          <Bone loading={loading}>{timeAgo(d.createdAt)}</Bone>
        </p>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground max-md:hidden">
          <span>by</span>
          <Bone box loading={loading}>
            <DeploymentCreator
              creator={d.creator}
              creatorUser={d.creatorUser}
              creatorProvider={d.creatorProvider}
              creatorUrl={d.creatorUrl}
              size="xs"
            />
          </Bone>
        </p>
      </TableCell>

      <TableCell className="text-right max-md:order-5 max-md:ml-auto">
        <Bone box loading={loading} className="w-full">
          <DeploymentActions
            id={d.id}
            appId={d.appId}
            appSlug={d.appSlug}
            url={d.url}
            status={d.status}
            pullRequestUrl={d.pullRequestUrl}
            isPreview={d.prNumber != null}
            previewId={d.previewId}
            canDelete={canManage && !d.appMigrating}
            canDeploy={canManage && !d.appMigrating}
            canRollback={d.canRollback && !d.appMigrating}
            canRollbackApps={canRollbackApps}
            rollbackRebuilds={d.rollbackRebuilds}
            commitSha={d.commitSha}
            commitMessage={d.commitMessage}
            onRemoved={onRemoved}
            onRestored={onRestored}
          />
        </Bone>
      </TableCell>
    </TableRow>
  );
}
