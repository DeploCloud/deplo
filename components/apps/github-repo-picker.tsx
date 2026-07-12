"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Search,
  Lock,
  RefreshCw,
  Check,
  ChevronsUpDown,
  Plus,
  SlidersHorizontal,
  Building2,
  User as UserIcon,
  ExternalLink,
  GitBranch,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/info-tip";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { useGithubConnect } from "@/components/apps/github-connect-button";
import { cn, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { GithubInstallationDTO } from "@/lib/data/github";
import type { GithubRepoSummary } from "@/lib/github/app";

export interface GithubSelection {
  installationId: string;
  fullName: string;
  branch: string;
}

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

/** GitHub's per-installation "configure repository access" settings page. */
function installationSettingsUrl(inst: GithubInstallationDTO): string {
  return inst.accountType === "Organization"
    ? `https://github.com/organizations/${inst.accountLogin}/settings/installations/${inst.installationId}`
    : `https://github.com/settings/installations/${inst.installationId}`;
}

/** A round GitHub account avatar with an initials fallback if the image fails. */
function AccountAvatar({
  inst,
  className,
}: {
  inst: GithubInstallationDTO;
  className?: string;
}) {
  return (
    <Avatar className={cn("size-5", className)}>
      <AvatarImage src={inst.avatarUrl} alt="" />
      <AvatarFallback className="text-[10px]">
        {inst.accountLogin.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** The connect-your-first-App empty state, shown when no App is connected yet. */
function ConnectPanel({
  connect,
  connecting,
}: {
  connect: () => void;
  connecting: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
      <GitHubIcon className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Connect GitHub to pick a repo</p>
        <p className="text-xs text-muted-foreground">
          Deplo creates a GitHub App with only the permissions it needs, then you
          pick which repositories it can access.
        </p>
      </div>
      <Button type="button" size="sm" onClick={connect} disabled={connecting}>
        <GitHubIcon className="size-4" />
        {connecting ? "Redirecting…" : "Connect GitHub"}
      </Button>
    </div>
  );
}

/**
 * Repo source picker for the GitHub deploy source (app settings + the
 * new-app wizard): choose the connected account, search the repositories its
 * App installation can access, then pick a branch. Replaces pasting a raw
 * repository URL  the URL is built from the chosen repo and cloned with the
 * App's installation token.
 *
 * The account switcher is ALWAYS rendered — even with zero connected Apps — so
 * the layout never jumps and there's always an obvious path to connect or manage
 * Apps. Once a repo is chosen the search list collapses to a compact "selected
 * repo" card (Change reopens it), so the common already-configured case reads as
 * a confirmation, not a wall of repositories. `manageHref`, when set, adds a
 * "Manage connected apps" affordance linking to the team's GitHub settings.
 */
export function GithubRepoPicker({
  installations,
  initial,
  onChange,
  manageHref,
}: {
  installations: GithubInstallationDTO[];
  /**
   * Pre-select a repo/branch already attached to the app (settings flow).
   * The installation is matched by id; when it isn't among the connected
   * installations (e.g. the App was reinstalled) the first one is used.
   */
  initial?: { installationId?: string | null; fullName: string; branch: string };
  onChange: (value: GithubSelection | null) => void;
  /** When set, show a "Manage connected apps" link pointing here (e.g. /settings/git). */
  manageHref?: string;
}) {
  const { connect, pending: connecting } = useGithubConnect();
  const [installationId, setInstallationId] = React.useState(
    (initial?.installationId &&
      installations.some((i) => i.id === initial.installationId)
      ? initial.installationId
      : installations[0]?.id) ?? "",
  );
  const [repos, setRepos] = React.useState<GithubRepoSummary[]>([]);
  const [loadingRepos, setLoadingRepos] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<GithubRepoSummary | null>(null);
  const [branches, setBranches] = React.useState<string[]>([]);
  const [branch, setBranch] = React.useState("");
  // Once a repo is chosen the list collapses to a compact "selected repo" summary;
  // "Change" flips this back on to reveal the search + list again.
  const [browsing, setBrowsing] = React.useState(false);
  // Apply the initial selection only against the first repo list we load for
  // the installation it belongs to; afterwards the user is in control.
  const seededRef = React.useRef(false);
  // Mirror the latest `initial` in a ref so the one-time seed in loadRepos can
  // read it WITHOUT making loadRepos reactive to it. If loadRepos depended on
  // initial.fullName / initial.branch, a post-save router.refresh — which feeds
  // the freshly-saved branch back in as `initial` — would give loadRepos a new
  // identity, re-fire the load effect, null the current selection, and (seeding
  // being one-time) strand the user on the repo browse list. The repo list must
  // reload only when the installation changes.
  const initialRef = React.useRef(initial);
  React.useEffect(() => {
    initialRef.current = initial;
  });

  const activeInstallation =
    installations.find((i) => i.id === installationId) ?? null;
  const hasInstallations = installations.length > 0;

  const loadRepos = React.useCallback(
    async (instId: string) => {
      if (!instId) return;
      setLoadingRepos(true);
      setSelected(null);
      setBranches([]);
      setBranch("");
      const res = await gqlAction<
        { githubRepos: GithubRepoSummary[] },
        GithubRepoSummary[]
      >(
        `query($installationId: String!) {
          githubRepos(installationId: $installationId) {
            fullName
            name
            private
            defaultBranch
            url
            updatedAt
          }
        }`,
        { installationId: instId },
        (d) => d.githubRepos,
      );
      setLoadingRepos(false);
      if (res.ok && res.data) {
        setRepos(res.data);
        // Seed the existing project repo once it's in the fetched list. Read the
        // latest `initial` from the ref so this callback stays identity-stable.
        const seed = initialRef.current;
        if (!seededRef.current && seed) {
          const match = res.data.find((r) => r.fullName === seed.fullName);
          if (match) {
            seededRef.current = true;
            setSelected(match);
            setBranch(seed.branch || match.defaultBranch);
            setBranches([seed.branch || match.defaultBranch]);
            void hydrateBranches(instId, match, seed.branch);
          }
        }
      } else {
        setRepos([]);
        if (!res.ok) toast.error(res.error);
      }
    },
    // Identity-stable: the seed reads `initialRef.current`, so a changed `initial`
    // (e.g. the just-saved branch fed back by router.refresh) must NOT recreate
    // this callback and re-fire the load effect. Reloads are driven only by instId.
    [],
  );

  async function hydrateBranches(
    instId: string,
    repo: GithubRepoSummary,
    preferred?: string,
  ) {
    const res = await gqlAction<{ githubBranches: string[] }, string[]>(
      `query($installationId: String!, $fullName: String!) {
        githubBranches(installationId: $installationId, fullName: $fullName)
      }`,
      { installationId: instId, fullName: repo.fullName },
      (d) => d.githubBranches,
    );
    if (res.ok && res.data && res.data.length) {
      setBranches(res.data);
      const want = preferred && res.data.includes(preferred) ? preferred : null;
      setBranch(
        want ??
          (res.data.includes(repo.defaultBranch)
            ? repo.defaultBranch
            : res.data[0]),
      );
    }
  }

  React.useEffect(() => {
    // Fetch repos for the active installation (sync with GitHub, an external
    // system) whenever it changes  the load helper manages its own state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRepos(installationId);
  }, [installationId, loadRepos]);

  // Bubble the full selection up only once a repo + branch are settled.
  React.useEffect(() => {
    if (selected && branch) {
      onChange({ installationId, fullName: selected.fullName, branch });
    } else {
      onChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, branch, installationId]);

  async function pickRepo(repo: GithubRepoSummary) {
    setSelected(repo);
    setBrowsing(false);
    setBranch(repo.defaultBranch);
    setBranches([repo.defaultBranch]);
    await hydrateBranches(installationId, repo);
  }

  const filtered = query
    ? repos.filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase()))
    : repos;

  return (
    <div className="space-y-3">
      {/* Account — always rendered so the layout is stable and there's always a
          path to switch, connect, or manage Apps, even with none connected. */}
      <div className="space-y-1.5">
        <FieldLabel
          className="text-sm font-medium"
          info="The connected GitHub App / account whose repositories you deploy from. Switch accounts, connect another, or manage your connected apps."
        >
          GitHub account
        </FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 basis-64 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                {activeInstallation ? (
                  <>
                    <AccountAvatar inst={activeInstallation} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {activeInstallation.accountLogin}
                    </span>
                    {activeInstallation.accountType === "Organization" ? (
                      <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <UserIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </>
                ) : (
                  <>
                    <GitHubIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      No connected apps
                    </span>
                  </>
                )}
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-64">
              {hasInstallations && (
                <>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Connected accounts
                  </DropdownMenuLabel>
                  {installations.map((i) => (
                    <DropdownMenuItem
                      key={i.id}
                      onSelect={() => setInstallationId(i.id)}
                      className="gap-2"
                    >
                      <AccountAvatar inst={i} />
                      <span className="min-w-0 flex-1 truncate">
                        {i.accountLogin}
                      </span>
                      {i.id === installationId && (
                        <Check className="size-4 shrink-0 text-[var(--success)]" />
                      )}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                onSelect={connect}
                disabled={connecting}
                className="gap-2"
              >
                <Plus className="size-4" />
                {hasInstallations ? "Connect another account" : "Connect GitHub"}
              </DropdownMenuItem>
              {manageHref && (
                <DropdownMenuItem asChild className="gap-2">
                  <Link href={manageHref}>
                    <SlidersHorizontal className="size-4" />
                    Manage connected apps
                  </Link>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {manageHref && (
            <Button variant="outline" size="sm" asChild>
              <Link href={manageHref}>
                <SlidersHorizontal className="size-4" />
                Manage connected apps
              </Link>
            </Button>
          )}
        </div>
      </div>

      {!hasInstallations ? (
        <ConnectPanel connect={connect} connecting={connecting} />
      ) : selected && !browsing ? (
        // Chosen repo — a compact confirmation with its branch, so the common
        // "already picked" case isn't a wall of repos. "Change" reopens the list.
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-accent/30 p-3">
            {activeInstallation && (
              <AccountAvatar inst={activeInstallation} className="size-8" />
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
            <a
              href={selected.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open repository on GitHub"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="size-4" />
            </a>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setBrowsing(true)}
            >
              Change
            </Button>
          </div>

          <div className="space-y-2">
            <FieldLabel
              className="text-sm font-medium"
              info="The branch Deplo clones and deploys. New pushes to it can trigger a redeploy."
            >
              Branch
            </FieldLabel>
            <Select value={branch} onValueChange={setBranch}>
              <SelectTrigger className="max-w-xs">
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
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel
              className="text-sm font-medium"
              info="Search the repositories this GitHub App installation can access. Don't see one? Grant the App access to it on GitHub."
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
              placeholder="Search repositories…"
              className="pl-9 pr-9"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
              onClick={() => loadRepos(installationId)}
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
                    ? "No repositories accessible to this App."
                    : "No repositories match your search."}
                </p>
                {repos.length === 0 && activeInstallation && (
                  <a
                    href={installationSettingsUrl(activeInstallation)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    Configure repository access on GitHub
                    <ExternalLink className="size-3" />
                  </a>
                )}
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
      )}
    </div>
  );
}
