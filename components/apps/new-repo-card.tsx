"use client";

import * as React from "react";
import { X } from "lucide-react";
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
import { docsUrl } from "@/lib/docs";
import { newAppHref } from "@/lib/overview-links";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import type { NewRepo } from "@/lib/data/new-repos";

const storageKey = (teamId: string) => `deplo:new-repo-dismissed:${teamId}`;
const keyOf = (repo: NewRepo) => `${repo.provider}:${repo.fullName}`;

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

// The suggestions this member has not hidden; null until the browser has been read.
export function useShownRepos(repos: NewRepo[], teamId: string) {
  const [hidden, setHidden] = React.useState<string[] | null>(null);
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHidden(readHidden(teamId));
  }, [teamId]);

  const shown = hidden && repos.filter((r) => !hidden.includes(keyOf(r)));
  function hide(these: NewRepo[]) {
    const next = [...new Set([...readHidden(teamId), ...these.map(keyOf)])];
    try {
      window.localStorage.setItem(
        storageKey(teamId),
        JSON.stringify(next.slice(-50)),
      );
    } catch {}
    setHidden(next);
  }
  return { shown, hide };
}

export function NewRepoCard({
  repos,
  teamId,
  view,
}: {
  repos: NewRepo[];
  teamId: string;
  view: "grid" | "list";
}) {
  const router = useRouter();
  const { shown, hide } = useShownRepos(repos, teamId);
  if (!shown || shown.length === 0) return null;

  async function stopSuggesting() {
    const res = await gqlAction(
      `mutation { setSuggestNewRepos(enabled: false) }`,
    );
    if (!res.ok) return void toast.error(res.error);
    toast.success("Suggestions are off. Turn them back on in Settings, Git.");
    router.refresh();
  }

  const one = shown.length === 1;
  const importButton = (size: "sm" | "default", className?: string) => (
    <Button asChild size={size} className={className}>
      <Link href={newAppHref(null, { detected: "1" })}>Import</Link>
    </Button>
  );

  const marks = (
    <div className="flex shrink-0 -space-x-2">
      {shown.map((repo) => (
        <GitProviderMark
          key={keyOf(repo)}
          provider={repo.provider}
          className="size-8 rounded-full border border-border ring-2 ring-background"
        />
      ))}
    </div>
  );

  const text = (
    <div className="min-w-0 flex-1">
      <p className="truncate font-medium">
        {one ? "New repository detected" : "New repositories detected"}
      </p>
      <p className="mt-1 truncate text-sm text-muted-foreground">
        {shown.map((r) => r.name).join(", ")}
      </p>
    </div>
  );

  return (
    <div className="relative">
      <Card className="h-full bg-transparent p-2">
        {view === "list" ? (
          <div className="flex items-center gap-4 rounded-lg border border-dashed px-4 py-3">
            {marks}
            {text}
            {importButton("sm")}
          </div>
        ) : (
          <div className="flex h-full flex-col justify-between gap-4 rounded-lg border border-dashed p-4">
            <div className="flex items-center gap-3">
              {marks}
              {text}
            </div>
            {importButton("default", "w-full")}
          </div>
        )}
      </Card>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Dismiss"
            className="absolute -top-2.5 -right-2.5 size-6 rounded-full text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => hide(shown)}>
            {one ? "Hide this repository" : "Hide these repositories"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void stopSuggesting()}>
            Stop suggesting repositories
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a
              href={docsUrl("deploy.newRepos")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
