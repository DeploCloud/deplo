"use client";

import * as React from "react";
import { ArrowRight, GitBranch, Loader2, Lock, X } from "lucide-react";
import { toast } from "sonner";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GitProviderMark } from "@/components/shared/brand-icons";
import { submitCreatedApp } from "@/components/apps/new-app-wizard/create-app";
import { nameFromRepo } from "@/components/apps/new-app-wizard/source-hints";
import { HOSTS } from "@/lib/git/providers/hosts";
import { docsUrl } from "@/lib/docs";
import { newAppHref } from "@/lib/overview-links";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import { cn, timeAgo } from "@/lib/utils";
import { deploySourceEnumName } from "@/lib/types/app";
import type { NewRepo } from "@/lib/data/new-repos";
import type { GitProviderId } from "@/lib/types/git";

const storageKey = (teamId: string) => `deplo:new-repo-dismissed:${teamId}`;

function readHidden(teamId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(storageKey(teamId)) ?? "[]",
    );
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function NewRepoCard({
  repo,
  teamId,
  view,
}: {
  repo: NewRepo;
  teamId: string;
  view: "grid" | "list";
}) {
  const router = useRouter();
  const key = `${repo.provider}:${repo.fullName}`;
  const [hidden, setHidden] = React.useState<boolean | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHidden(readHidden(teamId).includes(key));
  }, [teamId, key]);

  if (hidden !== false) return null;

  const host =
    repo.provider === "github"
      ? "GitHub"
      : (HOSTS[repo.provider as GitProviderId]?.label ?? "Git");

  function deploy() {
    const source = repo.installationId ? "github" : "git";
    startTransition(() =>
      submitCreatedApp(
        {
          name: nameFromRepo(repo.fullName),
          source: deploySourceEnumName(source),
          repo: {
            provider: repo.provider,
            url: repo.url,
            repo: repo.fullName,
            branch: repo.defaultBranch,
            installationId: repo.installationId,
            connectionId: repo.connectionId,
          },
          folderId: null,
          projectId: null,
          environmentId: null,
        },
        { router, source, uploadFile: null },
      ),
    );
  }

  function hide() {
    const next = [...readHidden(teamId).filter((k) => k !== key), key];
    try {
      window.localStorage.setItem(
        storageKey(teamId),
        JSON.stringify(next.slice(-50)),
      );
    } catch {}
    setHidden(true);
  }

  async function stopSuggesting() {
    const res = await gqlAction(
      `mutation { setSuggestNewRepos(enabled: false) }`,
    );
    if (!res.ok) return void toast.error(res.error);
    toast.success("Suggestions are off. Turn them back on in Settings, Git.");
    router.refresh();
  }

  const configure = (
    <Link
      href={newAppHref(null, {
        repo: repo.fullName,
        branch: repo.defaultBranch,
        installation: repo.installationId ?? undefined,
        connection: repo.connectionId ?? undefined,
      })}
      className="pointer-events-auto text-xs text-muted-foreground hover:text-foreground hover:underline"
    >
      Configure
    </Link>
  );
  const deployLabel = (
    <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
      Deploy
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <ArrowRight className="size-3.5" />
      )}
    </span>
  );
  const identity = (
    <>
      {repo.private && <Lock className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate">{repo.fullName}</span>
      <span className="shrink-0 text-muted-foreground/40">·</span>
      <GitBranch className="size-3 shrink-0" />
      <span className="max-w-32 truncate">{repo.defaultBranch}</span>
    </>
  );
  const title = (
    <div className="min-w-0 flex-1">
      <span className="block truncate font-medium">{repo.name}</span>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        New on {host} · {timeAgo(repo.createdAt)}
      </p>
    </div>
  );
  const overlay = (
    <button
      type="button"
      onClick={deploy}
      disabled={pending}
      aria-label={`Deploy ${repo.fullName}`}
      className="absolute inset-0 cursor-pointer rounded-xl disabled:cursor-wait"
    />
  );
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          className="pointer-events-auto relative z-[2] shrink-0 text-muted-foreground"
        >
          <X className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={hide}>
          Hide this repository
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void stopSuggesting()}>
          Stop suggesting repositories
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={docsUrl("deploy.newRepos")} target="_blank" rel="noreferrer">
            Learn more
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const shell = cn(
    "group relative border-dashed transition-colors hover:border-primary/50",
    pending && "animate-pulse",
  );

  if (view === "list")
    return (
      <Card
        aria-busy={pending}
        className={cn(shell, "flex items-center gap-4 p-4")}
      >
        {overlay}
        <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-4">
          <GitProviderMark provider={repo.provider} />
          {title}
          <div className="hidden max-w-64 items-center gap-1.5 text-xs text-muted-foreground lg:flex">
            {identity}
          </div>
          {configure}
          {deployLabel}
        </div>
        {menu}
      </Card>
    );

  return (
    <Card aria-busy={pending} className={cn(shell, "flex flex-col gap-4 p-5")}>
      {overlay}
      <div className="pointer-events-none relative z-[1] flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <GitProviderMark provider={repo.provider} />
          {title}
        </div>
        {menu}
      </div>
      <div className="pointer-events-none relative z-[1] rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">{identity}</div>
        <div className="mt-2 flex items-center justify-between gap-2">
          {configure}
          {deployLabel}
        </div>
      </div>
    </Card>
  );
}
