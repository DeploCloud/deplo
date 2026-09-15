"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter, useTeamSlug } from "@/lib/nav";
import { withTeam } from "@/lib/team-path";
import { GitBranch, GitPullRequest, Hammer, Undo2 } from "lucide-react";
import { DeploymentCreator } from "@/components/apps/deployment-creator";
import { AppLogo } from "@/components/shared/project-logo";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/status-badge";
import { CommitLink } from "@/components/apps/commit-link";
import { DeploymentActions } from "@/components/apps/deployment-actions";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";
import { IN_PROGRESS } from "./deployment-status";
import type { DeploymentStatus } from "@/lib/types/deployment";

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
  pullRequestUrl?: string | null;
  prNumber?: number | null;
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
}) {
  const inProgress = IN_PROGRESS.has(d.status);
  return (
    <TableRow
      data-state={checked ? "selected" : undefined}
      className="cursor-pointer"
      onClick={(e) => onOpen(d, e)}
      onAuxClick={(e) => {
        if (e.button === 1) onOpen(d, e);
      }}
    >
      {canManage && (
        <TableCell data-no-row-nav>
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
              <Checkbox
                checked={checked}
                disabled={inProgress || d.appMigrating}
                onCheckedChange={(v) => onToggle(v === true)}
                aria-label={`Select deployment ${d.commitSha}`}
              />
            </span>
          </SimpleTooltip>
        </TableCell>
      )}

      <TableCell className="max-w-[280px]">
        <Link
          href={`/apps/${d.appSlug}/deployments/${d.id}`}
          className="block truncate font-medium text-foreground hover:underline focus-visible:underline"
        >
          {d.commitMessage}
        </Link>
        <span className="flex items-center gap-1.5">
          <CommitLink
            sha={d.commitSha}
            url={d.commitUrl}
            className="font-mono text-xs text-muted-foreground"
          />
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
                <Undo2 className="size-3" />
                Rollback
              </Badge>
            </SimpleTooltip>
          ) : null}
        </span>
      </TableCell>

      {showApp && (
        <TableCell>
          <SimpleTooltip content="Open this deployment's build logs">
            <Link
              href={`/apps/${d.appSlug}/deployments/${d.id}`}
              className="flex cursor-pointer items-center gap-2 font-medium text-foreground hover:underline"
            >
              <AppLogo logo={d.appLogo ?? null} size={20} />
              <span className="truncate">{d.serviceName}</span>
            </Link>
          </SimpleTooltip>
        </TableCell>
      )}

      {showServer && (
        <TableCell>
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
                <span className="truncate">{d.serverName}</span>
              </span>
            </SimpleTooltip>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      )}

      <TableCell>
        <StatusBadge status={liveStatus} />
      </TableCell>

      <TableCell>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate font-mono text-xs">{d.branch}</span>
        </span>
      </TableCell>

      <TableCell>
        <p className="whitespace-nowrap text-foreground">
          {timeAgo(d.createdAt)}
        </p>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <span>by</span>
          <DeploymentCreator
            creator={d.creator}
            creatorUser={d.creatorUser}
            creatorProvider={d.creatorProvider}
            creatorUrl={d.creatorUrl}
            size="xs"
          />
        </p>
      </TableCell>

      <TableCell className="text-right">
        <DeploymentActions
          id={d.id}
          appId={d.appId}
          appSlug={d.appSlug}
          url={d.url}
          status={d.status}
          pullRequestUrl={d.pullRequestUrl}
          canDelete={canManage && !d.appMigrating}
          canDeploy={canManage && !d.appMigrating}
          canRollback={d.canRollback && !d.appMigrating}
          canRollbackApps={canRollbackApps}
          commitSha={d.commitSha}
          commitMessage={d.commitMessage}
          onRemoved={onRemoved}
          onRestored={onRestored}
        />
      </TableCell>
    </TableRow>
  );
}
