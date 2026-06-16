"use client";

import * as React from "react";
import { toast } from "sonner";
import { Search, Lock, RefreshCw, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  listGithubReposAction,
  listGithubBranchesAction,
} from "@/lib/actions/github";
import type { GithubInstallationDTO } from "@/lib/data/github";
import type { GithubRepoSummary } from "@/lib/github/app";

export interface GithubSelection {
  installationId: string;
  fullName: string;
  branch: string;
}

/**
 * Repo source picker for the new-project wizard: choose an installation, search
 * the repositories it can access, then pick a branch. Replaces pasting a raw
 * repository URL  the URL is built from the chosen repo and cloned with the
 * App's installation token.
 */
export function GithubRepoPicker({
  installations,
  onChange,
}: {
  installations: GithubInstallationDTO[];
  onChange: (value: GithubSelection | null) => void;
}) {
  const [installationId, setInstallationId] = React.useState(
    installations[0]?.id ?? "",
  );
  const [repos, setRepos] = React.useState<GithubRepoSummary[]>([]);
  const [loadingRepos, setLoadingRepos] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<GithubRepoSummary | null>(null);
  const [branches, setBranches] = React.useState<string[]>([]);
  const [branch, setBranch] = React.useState("");

  const loadRepos = React.useCallback(async (instId: string) => {
    if (!instId) return;
    setLoadingRepos(true);
    setSelected(null);
    setBranches([]);
    setBranch("");
    const res = await listGithubReposAction(instId);
    setLoadingRepos(false);
    if (res.ok && res.data) setRepos(res.data);
    else {
      setRepos([]);
      if (!res.ok) toast.error(res.error);
    }
  }, []);

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
    setBranch(repo.defaultBranch);
    setBranches([repo.defaultBranch]);
    const res = await listGithubBranchesAction(installationId, repo.fullName);
    if (res.ok && res.data && res.data.length) {
      setBranches(res.data);
      if (!res.data.includes(repo.defaultBranch)) setBranch(res.data[0]);
    }
  }

  const filtered = query
    ? repos.filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase()))
    : repos;

  return (
    <div className="space-y-3">
      {installations.length > 1 && (
        <Select value={installationId} onValueChange={setInstallationId}>
          <SelectTrigger>
            <SelectValue placeholder="Select an account" />
          </SelectTrigger>
          <SelectContent>
            {installations.map((i) => (
              <SelectItem key={i.id} value={i.id}>
                {i.accountLogin}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search repositories…"
          className="pl-9"
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
          <p className="p-4 text-center text-sm text-muted-foreground">
            Loading repositories…
          </p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">
            {repos.length === 0
              ? "No repositories. Grant the App access to more repos on GitHub."
              : "No repositories match your search."}
          </p>
        ) : (
          filtered.map((repo) => (
            <button
              key={repo.fullName}
              type="button"
              onClick={() => pickRepo(repo)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                selected?.fullName === repo.fullName && "bg-accent",
              )}
            >
              <span className="flex-1 truncate font-mono text-xs">
                {repo.fullName}
              </span>
              {repo.private && (
                <Lock className="size-3.5 text-muted-foreground" />
              )}
              {selected?.fullName === repo.fullName && (
                <Check className="size-4 text-[var(--success)]" />
              )}
            </button>
          ))
        )}
      </div>

      {selected && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Branch</label>
          <Select value={branch} onValueChange={setBranch}>
            <SelectTrigger className="max-w-xs">
              <SelectValue />
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
      )}
    </div>
  );
}
