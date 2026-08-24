"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronsUpDown,
  Check,
  GitBranch,
  Plus,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  RepoBrowser,
  type RepoSelection,
} from "@/components/apps/repo-browser";
import { GitProviderMark } from "@/components/shared/brand-icons";
import type { GitConnectionDTO } from "@/lib/data/git-connections";

/** What the Git source resolves to, ready to become a `GitRepoInput`. */
export interface GitSourceValue {
  provider: string;
  url: string;
  repo: string;
  branch: string;
  connectionId: string | null;
}

/** owner/name pulled out of a clone URL, for display and webhook matching. */
function repoNameFromUrl(url: string): string {
  return (
    url
      .trim()
      .replace(/\.git$/, "")
      .match(/[/:]([\w.~-]+(?:\/[\w.~-]+)+)$/)?.[1] ?? url.trim()
  );
}

/** Recognise the host in a pasted URL, so a bare URL still labels itself. */
function providerFromUrl(url: string): string {
  if (/gitlab/i.test(url)) return "gitlab";
  if (/bitbucket/i.test(url)) return "bitbucket";
  if (/gitea|forgejo|codeberg/i.test(url)) return "gitea";
  if (/github/i.test(url)) return "github";
  return "git";
}

/**
 * The Git deploy source: choose which credential to clone with, then the
 * repository.
 *
 * The provider lives in a dropdown INSIDE this card rather than as a sixth chip
 * on the Deploy Source row: GitHub is the recommended path and stays the first
 * chip, everything else is beta and sits one level in. The default entry is
 * "Repository URL" - a plain public clone, which is exactly what the Git source
 * did before providers existed, so nothing an existing app does changes.
 *
 * A connection that can list repositories gets the SAME picker GitHub gets
 * ({@link RepoBrowser}); a plain git server keeps the two text fields, because
 * there is nothing to browse.
 */
export function GitSourcePicker({
  connections,
  initial,
  onChange,
  manageHref = "/settings/git",
}: {
  connections: GitConnectionDTO[];
  initial?: {
    connectionId?: string | null;
    url?: string;
    repo?: string;
    branch?: string;
  };
  onChange: (value: GitSourceValue) => void;
  manageHref?: string;
}) {
  const urlFieldId = React.useId();
  const branchFieldId = React.useId();
  const [connectionId, setConnectionId] = React.useState<string | null>(
    initial?.connectionId &&
      connections.some((c) => c.id === initial.connectionId)
      ? initial.connectionId
      : null,
  );
  const [url, setUrl] = React.useState(initial?.url ?? "");
  const [branch, setBranch] = React.useState(initial?.branch ?? "");

  const active = connections.find((c) => c.id === connectionId) ?? null;

  // Everything the parent needs, recomputed from whichever arm is active.
  // Routed through a ref so `emit` keeps a stable identity (the effects below
  // must not re-fire on every parent render) while still calling the LATEST
  // callback - a parent whose handler closes over its own state would otherwise
  // act on the state it had at mount.
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });
  const emit = React.useCallback((v: GitSourceValue) => {
    onChangeRef.current(v);
  }, []);

  // The plain-URL and plain-git arms: the two text fields ARE the value.
  React.useEffect(() => {
    if (active?.hasApi) return;
    emit({
      provider: active ? active.provider : providerFromUrl(url),
      url: url.trim(),
      repo: repoNameFromUrl(url),
      branch: branch.trim() || "main",
      connectionId: active ? active.id : null,
    });
  }, [active, url, branch, emit]);

  // The browsing arm: the repo picker owns repo + branch.
  const handleBrowsed = React.useCallback(
    (sel: RepoSelection | null) => {
      if (!active || !sel) return;
      emit({
        provider: active.provider,
        url: `${active.baseUrl.replace(/\/+$/, "")}/${sel.fullName}`,
        repo: sel.fullName,
        branch: sel.branch,
        connectionId: active.id,
      });
    },
    [active, emit],
  );

  function pick(id: string | null) {
    if (id === connectionId) return;
    setConnectionId(id);
    // Switching credentials invalidates whatever repository was typed for the
    // previous one - a URL on gitlab.com means nothing to a Gitea token.
    setUrl("");
    setBranch("");
    const next = connections.find((c) => c.id === id) ?? null;
    // The text arms re-emit from the effect above; the browsing arm emits only
    // once a repository is chosen, so clear the value here or Save would commit
    // the PREVIOUS credential's repository under the new one.
    if (next?.hasApi) {
      emit({
        provider: next.provider,
        url: "",
        repo: "",
        branch: "",
        connectionId: next.id,
      });
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel
          className="text-sm font-medium"
          info="Which credentials Deplo clones with. Pick a connected provider to browse its repositories and get auto-deploy on push; Repository URL clones a public repo with no credentials."
        >
          Provider
          <Badge variant="info" className="text-[10px] font-normal">
            Beta
          </Badge>
        </FieldLabel>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:w-80"
            >
              {active ? (
                <>
                  <GitProviderMark
                    provider={active.provider}
                    className="size-5"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{active.label}</span>
                    {active.accountLogin && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {active.accountLogin}
                      </span>
                    )}
                  </span>
                  {active.health === "failing" && (
                    <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
                  )}
                </>
              ) : (
                <>
                  <GitProviderMark provider="git" className="size-5" />
                  <span className="min-w-0 flex-1 truncate">
                    Repository URL
                  </span>
                </>
              )}
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-72">
            <DropdownMenuItem onSelect={() => pick(null)} className="gap-2">
              <GitProviderMark provider="git" className="size-5" />
              <span className="min-w-0 flex-1 truncate">Repository URL</span>
              {connectionId === null && (
                <Check className="size-4 shrink-0 text-[var(--success)]" />
              )}
            </DropdownMenuItem>
            {connections.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Connected providers
                </DropdownMenuLabel>
                {connections.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onSelect={() => pick(c.id)}
                    className="gap-2"
                  >
                    <GitProviderMark provider={c.provider} className="size-5" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{c.label}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {c.baseUrl.replace(/^https?:\/\//, "")}
                      </span>
                    </span>
                    {c.id === connectionId && (
                      <Check className="size-4 shrink-0 text-[var(--success)]" />
                    )}
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2">
              <Link href={manageHref}>
                <Plus className="size-4" />
                Connect a git provider
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {active?.health === "failing" && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {active.healthError ||
            "This connection stopped working. Replace its token in Settings → Git."}
        </p>
      )}

      {active?.hasApi ? (
        <RepoBrowser
          kind="connection"
          sourceId={active.id}
          initial={
            initial?.repo
              ? { fullName: initial.repo, branch: initial.branch ?? "" }
              : undefined
          }
          onChange={handleBrowsed}
          avatarUrl={active.avatarUrl}
          avatarFallback={active.accountLogin || active.label}
          repoLinkLabel={`Open repository on ${active.label}`}
          emptyMessage={`No repositories this ${active.label} token can reach.`}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <FieldLabel
                htmlFor={urlFieldId}
                info="The HTTPS clone URL of the repository."
              >
                Repository URL
              </FieldLabel>
              <Input
                id={urlFieldId}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://git.example.com/acme/site.git"
              />
            </div>
            <div className="space-y-2">
              <FieldLabel
                htmlFor={branchFieldId}
                info="The branch Deplo clones and deploys."
              >
                Production Branch
              </FieldLabel>
              <Input
                id={branchFieldId}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
              />
            </div>
          </div>
          {active ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 shrink-0" />
              Cloned with the {active.label} credentials.
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" />
              Public repositories only. Connect a provider to deploy a private
              one and get auto-deploy on push.
            </p>
          )}
        </>
      )}
    </div>
  );
}
