"use client";

import { GitBranch, Lock } from "lucide-react";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { GitProviderMark } from "@/components/shared/brand-icons";
import { useShownRepos } from "@/components/apps/new-repo-card";
import { newAppHref } from "@/lib/overview-links";
import { timeAgo } from "@/lib/utils";
import type { NewRepo } from "@/lib/data/new-repos";

export function NewRepoList({
  repos,
  teamId,
}: {
  repos: NewRepo[];
  teamId: string;
}) {
  const { shown } = useShownRepos(repos, teamId);
  if (!shown) return null;
  if (shown.length === 0)
    return (
      <EmptyState
        icon={GitBranch}
        title="No new repositories"
        description="Repositories created in the last week show up here."
        docs="deploy.newRepos"
        action={
          <Button asChild size="sm">
            <Link href="/new">New app</Link>
          </Button>
        }
      />
    );

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {shown.map((repo) => (
        <li
          key={`${repo.provider}:${repo.fullName}`}
          className="flex items-center gap-3 p-3"
        >
          <GitProviderMark provider={repo.provider} className="size-8" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <span className="truncate">{repo.fullName}</span>
              {repo.private && (
                <Lock className="size-3 shrink-0 text-muted-foreground" />
              )}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              Created {timeAgo(repo.createdAt)} · {repo.defaultBranch}
            </p>
          </div>
          <Button asChild size="sm">
            <Link
              href={newAppHref(null, {
                repo: repo.fullName,
                branch: repo.defaultBranch,
                installation: repo.installationId ?? undefined,
                connection: repo.connectionId ?? undefined,
                detected: "1",
              })}
            >
              Import
            </Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}
