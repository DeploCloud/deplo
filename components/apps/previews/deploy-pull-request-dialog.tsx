"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GitBranch, GitFork, Loader2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { gql, gqlAction } from "@/lib/graphql-client";

interface OpenPullRequest {
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  fromFork: boolean;
  draft: boolean;
  authorLogin: string;
}

/**
 * Deploy a specific open pull request, on purpose.
 */
export function DeployPullRequestDialog({
  appId,
  repoBranch,
}: {
  appId: string;
  repoBranch: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [rows, setRows] = React.useState<OpenPullRequest[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState<number | null>(null);

  // Loaded from the open event rather than an effect: opening the dialog IS the
  // user action that should spend a GitHub API call, and doing it here keeps the
  // request out of the render path entirely.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    setLoading(true);
    setQuery("");
    void gql<{ openPullRequests: OpenPullRequest[] }>(
      `query ($appId: ID!) {
        openPullRequests(appId: $appId) {
          number title headRef baseRef fromFork draft authorLogin
        }
      }`,
      { appId },
    )
      .then((data) => setRows(data.openPullRequests ?? []))
      .catch((e: unknown) => {
        setRows([]);
        toast.error(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }

  const filtered = (rows ?? []).filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      p.title.toLowerCase().includes(q) ||
      p.headRef.toLowerCase().includes(q) ||
      String(p.number).includes(q)
    );
  });

  async function deploy(prNumber: number) {
    setBusy(prNumber);
    const res = await gqlAction(
      `mutation ($appId: ID!, $prNumber: Int!) {
        deployPullRequest(appId: $appId, prNumber: $prNumber) { id }
      }`,
      { appId, prNumber },
    );
    setBusy(null);
    if (res.ok) {
      toast.success("Building the preview");
      setOpen(false);
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" />
          New preview
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const first = filtered[0];
            if (first) void deploy(first.number);
          }}
        >
          <DialogHeader>
            <DialogTitle>Deploy a pull request</DialogTitle>
            <DialogDescription>
              Pick an open pull request and Deplo builds it a preview with its
              own URL.
            </DialogDescription>
          </DialogHeader>

          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search open pull requests"
          />

          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                {rows && rows.length === 0
                  ? "No open pull requests on this repository"
                  : "Nothing matches that search"}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((p) => (
                  <li
                    key={p.number}
                    className="flex items-center gap-3 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-sm">
                        <span className="font-mono text-muted-foreground">
                          #{p.number}
                        </span>
                        <span className="line-clamp-1">{p.title}</span>
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <GitBranch className="size-3" />
                          <span className="font-mono">{p.headRef}</span>
                          <span aria-hidden>to</span>
                          <span className="font-mono">{p.baseRef}</span>
                        </span>
                        {p.authorLogin && <span>@{p.authorLogin}</span>}
                        {p.draft && <Badge variant="secondary">Draft</Badge>}
                        {p.fromFork && (
                          <Badge variant="secondary" className="gap-1">
                            <GitFork className="size-3" />
                            Fork
                          </Badge>
                        )}
                        {p.baseRef !== repoBranch && (
                          <span>not the branch this app tracks</span>
                        )}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void deploy(p.number)}
                    >
                      {busy === p.number ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        "Deploy"
                      )}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
