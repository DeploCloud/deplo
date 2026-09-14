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

// Anything inside a row that owns its own click: links, buttons, the selection
// checkbox, and any cell explicitly opted out with `data-no-row-nav`.
const ROW_NAV_EXEMPT =
  'a, button, input, label, select, textarea, [role="checkbox"], [role="menuitem"], [data-no-row-nav]';

export interface DeploymentRow {
  id: string;
  appId: string;
  appSlug: string;
  serviceName: string;
  /** The app's logo - only the global page, the one place the column exists. */
  appLogo?: string | null;
  /** Owning server id - present on the global page (for the Server filter). */
  serverId?: string | null;
  /** Owning server name - present on the global page (for the Server column). */
  serverName?: string | null;
  /** The server this deploy BUILT on, when that was not the owning one. */
  buildServerName?: string | null;
  commitMessage: string;
  commitSha: string;
  commitUrl: string | null;
  /** The pull request this preview build came from, or null for production. */
  pullRequestUrl?: string | null;
  /** Denormalized pull request number - null for every non-PR row. */
  prNumber?: number | null;
  status: DeploymentStatus;
  branch: string;
  createdAt: string;
  creator: string;
  /** The account behind `creator` - null for a webhook push (a GitHub login). */
  creatorUser?: {
    name: string;
    username: string;
    avatarColor: string;
    avatarUrl: string | null;
  } | null;
  /** Set ⇒ `creator` is a login on this git host, not a Deplo account. */
  creatorProvider?: string | null;
  /** That account's profile on the host, when it can be linked. */
  creatorUrl?: string | null;
  url: string;
  /** The SERVER's answer on whether its image is still on the host. */
  canRollback?: boolean;
  /** This deployment WAS a rollback: it re-ran an older build's image. */
  rollbackOf?: string | null;
  /** A migration is still writing this row's app - the server refuses every
   *  action on it until the run ends. */
  appMigrating?: boolean;
}

// useOpenDeployment builds the whole-row click handler: anywhere that isn't a
// dedicated control opens that deployment's build logs & details.
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
      // A new tab is not the router, so this is the one push that has to put the
      // team on the path itself.
      window.open(withTeam(href, team), "_blank", "noopener,noreferrer");
      return;
    }
    router.push(href);
  };
}

// DeploymentTableRow is one deployment's row: selection, commit, app/server,
// live status, branch, who ran it and the row's actions.
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
        /* The checkbox cell opts out of row navigation entirely - its padding is
           aimed at while selecting, and a near-miss must not navigate away. */
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
        {/* The keyboard/screen-reader path to what the whole row does on click
            (a <tr> can't be a link itself). */}
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
          {/* Read off the deployment's own denormalized number, so it survives
              the preview being reaped. */}
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
          {/* On the global page the App name opens THIS row's build logs, not
              the app overview. */}
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
            // The BUILD server rides in the tooltip rather than a column of its
            // own: it is null for almost every row.
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
