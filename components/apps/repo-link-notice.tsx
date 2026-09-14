"use client";

import * as React from "react";
import { TriangleAlert, X } from "lucide-react";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";

// RepoLinkNotice - warns that an App names a repository but no credential for it.
export function RepoLinkNotice({
  slug,
  repoName,
}: {
  slug: string;
  repoName: string;
}) {
  const key = `deplo:repo-link-dismissed:${slug}`;
  const [dismissed, setDismissed] = React.useState<string | null>(null);

  React.useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(window.localStorage.getItem(key) ?? "");
    } catch {
      setDismissed("");
    }
  }, [key]);

  // `null` is "not read yet" - rendering earlier flashes an already-dismissed notice.
  if (dismissed === null || dismissed === repoName) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(key, repoName);
    } catch {}
    setDismissed(repoName);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-wash-strong px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="space-y-1">
          <p className="font-medium">No GitHub App is linked to this app</p>
          <p className="text-muted-foreground">
            This app deploys from{" "}
            <span className="font-medium text-foreground">{repoName}</span>{" "}
            through a GitHub App, but none is saved - a private repository will
            not clone, and pushes cannot deploy it.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button asChild size="sm" variant="outline">
          <Link href={`/apps/${slug}/settings/deployments`}>
            Deploy source settings
          </Link>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          onClick={dismiss}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
