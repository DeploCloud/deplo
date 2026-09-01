"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ExternalLink,
  GitBranch,
  GitFork,
  GitPullRequest,
  MoreHorizontal,
  RotateCw,
  ScrollText,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import { GitAccount } from "@/components/shared/git-account";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { StatusBadge } from "@/components/shared/status-badge";
import { useLiveApp } from "@/components/apps/app-live-status";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { gqlAction } from "@/lib/graphql-client";
import type { AppPreviewDTO } from "@/lib/data/previews";
import { gitProfileUrl } from "@/lib/utils";
import { TimeAgo } from "@/components/shared/time-ago";

/**
 * The pull request previews of one app.
 */
export function PreviewsTable({
  appSlug,
  previews,
  canDeploy,
  maxActive,
}: {
  appSlug: string;
  previews: AppPreviewDTO[];
  canDeploy: boolean;
  maxActive: number;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const live = useLiveApp();
  // A destroyed preview leaves the table on the click: the row is dropped
  // server-side before its stack comes down, so waiting out the teardown only
  // leaves a dead row with a live Destroy under the cursor.
  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(previews, (p) => p.id);

  // Any change to the owning app (a preview build starting, finishing, failing)
  // arrives on the same stream the header uses - re-read the rows when one lands
  // while something is in flight.
  const inFlight = rows.some(
    (p) => p.status === "queued" || p.status === "building",
  );
  const lastSeen = React.useRef<string | null>(null);
  React.useEffect(() => {
    const stamp = live
      ? `${live.status}:${live.latestDeploymentId ?? ""}`
      : null;
    if (stamp && stamp !== lastSeen.current) {
      lastSeen.current = stamp;
      if (inFlight) router.refresh();
    }
  }, [live, inFlight, router]);

  function run(
    query: string,
    variables: Record<string, unknown>,
    success: string,
    /** Undo whatever the caller took off the table when the server refuses. */
    onError?: () => void,
  ) {
    startTransition(async () => {
      const res = await gqlAction(query, variables);
      if (res.ok) toast.success(success);
      else {
        onError?.();
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  // What the cap actually counts: previews with a stack up. A closed pull
  // request has none, and neither has an `evicted` or `blocked` one - counting
  // those would show "at its limit" while slots were free.
  const liveCount = rows.filter(
    (p) => !p.closed && p.status !== "evicted" && p.status !== "blocked",
  ).length;

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pull request</TableHead>
              <TableHead className="w-[140px]">Status</TableHead>
              <TableHead>Preview</TableHead>
              <TableHead className="w-[120px]">Updated</TableHead>
              <TableHead className="w-[120px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => {
              const blocked = p.isFork && !p.approved;
              return (
                <TableRow key={p.id}>
                  <TableCell>
                    <a
                      href={p.pullRequestUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 text-sm font-medium hover:underline"
                    >
                      <span className="font-mono text-muted-foreground">
                        #{p.prNumber}
                      </span>
                      <span className="line-clamp-1">{p.title}</span>
                    </a>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <GitBranch className="size-3" />
                        <span className="font-mono">{p.headBranch}</span>
                        <span aria-hidden>to</span>
                        <span className="font-mono">{p.baseBranch}</span>
                      </span>
                      {/* Previews only ever come from a GitHub pull request, so
                          the author is an account there - drawn like every other
                          pusher, not as bare text. */}
                      {p.author && (
                        <GitAccount
                          login={p.author}
                          provider="github"
                          url={gitProfileUrl("github", p.author)}
                          size="xs"
                        />
                      )}
                      {p.isFork && (
                        <Badge variant="secondary" className="gap-1">
                          <GitFork className="size-3" />
                          {p.headRepo || "fork"}
                        </Badge>
                      )}
                    </p>
                  </TableCell>

                  <TableCell>
                    {blocked ? (
                      <Badge variant="outline" className="gap-1.5">
                        <ShieldAlert className="size-3.5 text-[var(--warning)]" />
                        Needs approval
                      </Badge>
                    ) : p.status === "evicted" ? (
                      // The one status whose CAUSE is a setting rather than anything that happened to the
                      // build, so the badge alone cannot finish the sentence: say which limit, and that
                      // getting it back costs one click and keeps the address.
                      <SimpleTooltip
                        content={`This app runs ${maxActive} previews at once, and this was the one nobody had touched in the longest. Redeploy brings it back on the same address, or raise the limit in Settings.`}
                      >
                        <span className="inline-flex">
                          <StatusBadge status={p.status} />
                        </span>
                      </SimpleTooltip>
                    ) : (
                      <StatusBadge status={p.status} />
                    )}
                  </TableCell>

                  <TableCell>
                    {p.status === "building" || p.status === "queued" ? (
                      <Skeleton className="h-4 w-40" />
                    ) : p.url && !p.closed && p.status !== "evicted" ? (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs hover:underline"
                      >
                        {p.host}
                      </a>
                    ) : p.status === "evicted" ? (
                      // The host is still RESERVED for this pull request - the row kept it, so Redeploy
                      // brings the same link back. It just answers nothing right now, so it must not look
                      // clickable.
                      <span
                        className="font-mono text-xs text-muted-foreground"
                        title="Redeploy to bring this address back"
                      >
                        {p.host}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Not deployed
                      </span>
                    )}
                  </TableCell>

                  <TableCell className="text-xs text-muted-foreground">
                    <TimeAgo at={p.updatedAt} />
                  </TableCell>

                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {blocked && canDeploy ? (
                        <ConfirmAction
                          variant="default"
                          trigger={
                            <Button size="sm" variant="outline">
                              Review and deploy
                            </Button>
                          }
                          title="Deploy this fork's code?"
                          description={`Pull request #${p.prNumber} comes from ${p.headRepo || "a fork"}, a repository you don't control. Building it runs that code on your server. Deplo never gives a fork preview your secret variables, but everything else about it is the pull request author's code. Only approve pull requests from people you trust. New commits on this pull request will deploy automatically once you approve.`}
                          confirmLabel="Approve and deploy"
                          successMessage="Building the preview"
                          optimistic
                          onConfirm={async () => {
                            const res = await gqlAction(
                              `mutation ($id: ID!) { approvePreview(id: $id) { id } }`,
                              { id: p.id },
                            );
                            if (res.ok) router.refresh();
                            return res;
                          }}
                        />
                      ) : (
                        p.url &&
                        !p.closed && (
                          <SimpleTooltip content="Open this preview in a new tab">
                            <Button asChild size="icon" variant="ghost">
                              <a href={p.url} target="_blank" rel="noreferrer">
                                <ExternalLink className="size-4" />
                              </a>
                            </Button>
                          </SimpleTooltip>
                        )
                      )}
                      {p.latestDeploymentId && (
                        <SimpleTooltip content="Open the build logs for this preview">
                          <Button asChild size="icon" variant="ghost">
                            <Link
                              href={`/apps/${appSlug}/deployments/${p.latestDeploymentId}`}
                            >
                              <ScrollText className="size-4" />
                            </Link>
                          </Button>
                        </SimpleTooltip>
                      )}
                      {canDeploy && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuItem
                              disabled={blocked}
                              onClick={() =>
                                run(
                                  `mutation ($id: ID!) { redeployPreview(id: $id) { id } }`,
                                  { id: p.id },
                                  "Redeploy started",
                                )
                              }
                            >
                              <RotateCw className="size-4" />
                              Redeploy
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <a
                                href={p.pullRequestUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <GitPullRequest className="size-4" />
                                Open pull request
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => {
                                remove(p.id);
                                run(
                                  `mutation ($id: ID!) { destroyPreview(id: $id) }`,
                                  { id: p.id },
                                  "Preview destroyed",
                                  () => restore(p.id),
                                );
                              }}
                            >
                              <Trash2 className="size-4" />
                              Destroy preview
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {liveCount >= maxActive && (
        <p className="text-xs text-muted-foreground">
          This app is at its limit of {maxActive} live previews. The next pull
          request still gets one - the preview nobody has touched in the longest
          is stopped to make room, and Redeploy brings it back on the same
          address. Raise the limit in Settings to keep more running at once.
        </p>
      )}
    </div>
  );
}
