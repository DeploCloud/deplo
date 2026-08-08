"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Check,
  ExternalLink,
  GitBranch,
  Lock,
  RefreshCw,
  Search,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/info-tip";
import { cn, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";

/** One repository as every provider's listing returns it. */
export interface RepoSummary {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  updatedAt: string;
}

export interface RepoSelection {
  fullName: string;
  branch: string;
}

/** Which credential lists the repositories: a GitHub App installation, or a git
 *  connection to any other host. Only the query name differs. */
export type RepoSourceKind = "github" | "connection";

// Varied bar widths so the loading placeholder reads like a real repo list
// instead of an even grid of identical lines.
const REPO_SKELETON_WIDTHS = [
  "w-1/2",
  "w-2/3",
  "w-2/5",
  "w-3/5",
  "w-1/3",
  "w-1/2",
];

/**
 * Pick a repository and a branch from a credential that can list them.
 *
 * The half of the source picker that has nothing to do with GitHub: search the
 * repositories, choose one, choose its branch. Extracted so GitLab, Bitbucket
 * and Gitea get the exact UX GitHub already had - the compact "already chosen"
 * card, the skeleton list, the branch dropdown - instead of a second, worse
 * picker written next to it.
 *
 * WHO the credential is stays outside: GitHub renders its App switcher above
 * this, the other providers use the Deploy Source card's own provider dropdown.
 */
export function RepoBrowser({
  kind,
  sourceId,
  initial,
  onChange,
  emptyMessage,
  emptyAction,
  avatarUrl,
  avatarFallback,
  repoLinkLabel = "Open repository",
}: {
  kind: RepoSourceKind;
  /** The installation or connection id. Changing it reloads the list. */
  sourceId: string;
  /** Pre-select the repo/branch already attached to the app (settings flow). */
  initial?: { fullName: string; branch: string };
  onChange: (value: RepoSelection | null) => void;
  emptyMessage?: string;
  /** Rendered under the empty message, e.g. a link to grant repository access. */
  emptyAction?: React.ReactNode;
  avatarUrl?: string;
  avatarFallback?: string;
  repoLinkLabel?: string;
}) {
  const branchFieldId = React.useId();
  const [repos, setRepos] = React.useState<RepoSummary[]>([]);
  const [loadingRepos, setLoadingRepos] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<RepoSummary | null>(null);
  const [branches, setBranches] = React.useState<string[]>([]);
  const [branch, setBranch] = React.useState("");
  // Once a repo is chosen the list collapses to a compact "selected repo"
  // summary; "Change" flips this back on to reveal the search + list again.
  const [browsing, setBrowsing] = React.useState(false);
  // Apply the initial selection only against the first repo list we load for
  // the source it belongs to; afterwards the user is in control.
  const seededRef = React.useRef(false);
  // Mirror the latest `initial` in a ref so the one-time seed in loadRepos can
  // read it WITHOUT making loadRepos reactive to it. If loadRepos depended on
  // initial.fullName / initial.branch, a post-save router.refresh - which feeds
  // the freshly-saved branch back in as `initial` - would give loadRepos a new
  // identity, re-fire the load effect, null the current selection, and (seeding
  // being one-time) strand the user on the repo browse list. The repo list must
  // reload only when the source changes.
  const initialRef = React.useRef(initial);
  React.useEffect(() => {
    initialRef.current = initial;
  });
  // Same reason: the loaders must not change identity when `kind` does (it
  // never does for a mounted browser, but the linter cannot know that).
  const kindRef = React.useRef(kind);
  React.useEffect(() => {
    kindRef.current = kind;
  });

  const fetchBranches = React.useCallback(
    async (id: string, fullName: string): Promise<string[]> => {
      const res =
        kindRef.current === "github"
          ? await gqlAction<{ githubBranches: string[] }, string[]>(
              `query($installationId: String!, $fullName: String!) {
                githubBranches(installationId: $installationId, fullName: $fullName)
              }`,
              { installationId: id, fullName },
              (d) => d.githubBranches,
            )
          : await gqlAction<{ gitBranches: string[] }, string[]>(
              `query($connectionId: String!, $fullName: String!) {
                gitBranches(connectionId: $connectionId, fullName: $fullName)
              }`,
              { connectionId: id, fullName },
              (d) => d.gitBranches,
            );
      return res.ok && res.data ? res.data : [];
    },
    [],
  );

  const hydrateBranches = React.useCallback(
    async (id: string, repo: RepoSummary, preferred?: string) => {
      const names = await fetchBranches(id, repo.fullName);
      if (!names.length) return;
      setBranches(names);
      const want = preferred && names.includes(preferred) ? preferred : null;
      setBranch(
        want ?? (names.includes(repo.defaultBranch) ? repo.defaultBranch : names[0]),
      );
    },
    [fetchBranches],
  );

  const loadRepos = React.useCallback(
    async (id: string) => {
      if (!id) return;
      setLoadingRepos(true);
      setSelected(null);
      setBranches([]);
      setBranch("");
      const res =
        kindRef.current === "github"
          ? await gqlAction<{ githubRepos: RepoSummary[] }, RepoSummary[]>(
              `query($installationId: String!) {
                githubRepos(installationId: $installationId) {
                  fullName name private defaultBranch url updatedAt
                }
              }`,
              { installationId: id },
              (d) => d.githubRepos,
            )
          : await gqlAction<{ gitRepos: RepoSummary[] }, RepoSummary[]>(
              `query($connectionId: String!) {
                gitRepos(connectionId: $connectionId) {
                  fullName name private defaultBranch url updatedAt
                }
              }`,
              { connectionId: id },
              (d) => d.gitRepos,
            );
      setLoadingRepos(false);
      if (res.ok && res.data) {
        setRepos(res.data);
        // Seed the existing app repo once it is in the fetched list. Read the
        // latest `initial` from the ref so this callback stays identity-stable.
        const seed = initialRef.current;
        if (!seededRef.current && seed) {
          const match = res.data.find((r) => r.fullName === seed.fullName);
          if (match) {
            seededRef.current = true;
            setSelected(match);
            setBranch(seed.branch || match.defaultBranch);
            setBranches([seed.branch || match.defaultBranch]);
            void hydrateBranches(id, match, seed.branch);
          }
        }
      } else {
        setRepos([]);
        if (!res.ok) toast.error(res.error);
      }
    },
    // Identity-stable: the seed reads `initialRef.current`, so a changed
    // `initial` (e.g. the just-saved branch fed back by router.refresh) must NOT
    // recreate this callback and re-fire the load effect. Reloads are driven
    // only by sourceId.
    [hydrateBranches],
  );

  React.useEffect(() => {
    // Fetch repos for the active source (sync with an external system) whenever
    // it changes - the load helper manages its own state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRepos(sourceId);
  }, [sourceId, loadRepos]);

  // Bubble the full selection up only once a repo + branch are settled.
  React.useEffect(() => {
    if (selected && branch) onChange({ fullName: selected.fullName, branch });
    else onChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, branch, sourceId]);

  async function pickRepo(repo: RepoSummary) {
    setSelected(repo);
    setBrowsing(false);
    setBranch(repo.defaultBranch);
    setBranches([repo.defaultBranch]);
    await hydrateBranches(sourceId, repo);
  }

  const filtered = query
    ? repos.filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase()))
    : repos;

  if (selected && !browsing) {
    // Chosen repo - a compact confirmation, so the common "already picked" case
    // isn't a wall of repos. "Change" reopens the list. The branch lives INSIDE
    // this card: it belongs to the chosen repository (it means nothing without
    // one, and changing repo re-picks it), so it reads as part of the source,
    // not as a second unrelated field below it.
    return (
      <div className="rounded-lg border border-border bg-accent/30">
        <div className="flex items-center gap-3 p-3">
          {avatarUrl !== undefined && (
            <Avatar className="size-8">
              <AvatarImage src={avatarUrl} alt="" />
              <AvatarFallback className="text-[10px]">
                {(avatarFallback ?? selected.fullName).slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">
                {selected.fullName}
              </span>
              {selected.private && (
                <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                  <Lock className="size-3" />
                  Private
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {selected.updatedAt
                ? `Updated ${timeAgo(selected.updatedAt)}`
                : "Selected repository"}
            </p>
          </div>
          {selected.url && (
            <a
              href={selected.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={repoLinkLabel}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="size-4" />
            </a>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setBrowsing(true)}
          >
            Change
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
          <FieldLabel
            htmlFor={branchFieldId}
            className="text-xs font-medium text-muted-foreground"
            info="The branch Deplo clones and deploys. New pushes to it can trigger a redeploy."
          >
            Branch
          </FieldLabel>
          <Select value={branch} onValueChange={setBranch}>
            <SelectTrigger
              id={branchFieldId}
              className="h-8 w-auto min-w-44 max-w-full bg-background"
            >
              {/* `flex!` is load-bearing: SelectTrigger applies
                  `[&>span]:line-clamp-1` to its direct-child spans, whose
                  `display:-webkit-box` outranks a plain `flex` class (the
                  `>span` selector is more specific) and would stack the icon
                  above the value. The important modifier keeps them on one row. */}
              <span className="flex! min-w-0 items-center gap-2">
                <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel
          className="text-sm font-medium"
          info="Search the repositories this credential can reach. Don't see one? Grant it access on your git provider."
        >
          Repository
        </FieldLabel>
        {selected && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setBrowsing(false)}
          >
            Cancel
          </Button>
        )}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search repositories"
          className="pl-9 pr-9"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
          onClick={() => loadRepos(sourceId)}
          aria-label="Refresh repositories"
        >
          <RefreshCw className={cn("size-4", loadingRepos && "animate-spin")} />
        </Button>
      </div>

      <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
        {loadingRepos ? (
          REPO_SKELETON_WIDTHS.map((width, i) => (
            <div key={i} className="flex w-full items-center gap-2 px-3 py-2">
              <Skeleton className={cn("h-3.5", width)} />
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 p-4 text-center">
            <p className="text-sm text-muted-foreground">
              {repos.length === 0
                ? (emptyMessage ?? "No repositories to show.")
                : "No repositories match your search."}
            </p>
            {repos.length === 0 && emptyAction}
          </div>
        ) : (
          filtered.map((repo) => {
            const isSelected = selected?.fullName === repo.fullName;
            const owner = repo.fullName.split("/")[0];
            return (
              <button
                key={repo.fullName}
                type="button"
                onClick={() => pickRepo(repo)}
                aria-pressed={isSelected}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                  isSelected && "bg-accent",
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{repo.name}</span>
                  <span className="text-muted-foreground"> · {owner}</span>
                </span>
                {repo.private && (
                  <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                {repo.updatedAt && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {timeAgo(repo.updatedAt)}
                  </span>
                )}
                {isSelected && (
                  <Check className="size-4 shrink-0 text-[var(--success)]" />
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
