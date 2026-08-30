// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The warning an App carries when it names a repository but no credential to reach
 * it with.
 */
export function RepoLinkNotice({
  slug,
  repoName,
}: {
  slug: string;
  repoName: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
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
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link href={`/apps/${slug}/settings/deployments`}>
          Deploy source settings
        </Link>
      </Button>
    </div>
  );
}
