// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import Link from "next/link";
import { ExternalLink, GitPullRequest } from "lucide-react";

import { getAppBySlug } from "@/lib/data/apps";
import { listAppPreviews } from "@/lib/data/previews";
import { hasCapability } from "@/lib/membership";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { EmptyState } from "@/components/shared/empty-state";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";
import { Button } from "@/components/ui/button";
import { DeployPullRequestDialog } from "@/components/apps/previews/deploy-pull-request-dialog";
import { PreviewsTable } from "@/components/apps/previews/previews-table";
import { PullRequestGraphic } from "@/components/apps/previews/pull-request-graphic";

export const metadata = { title: "Pull requests" };

/**
 * Pull request previews for one app.
 */
export default async function AppPullRequestsPage(
  props: PageProps<"/apps/[slug]/pull-requests">,
) {
  const { slug } = await props.params;
  const app = await getAppBySlug(slug);
  if (!app) notFound();
  const [view, canDeploy] = await Promise.all([
    listAppPreviews(app.id),
    hasCapability("manage_previews"),
  ]);

  const deployButton =
    canDeploy &&
    view.unavailable !== "not-github" &&
    view.unavailable !== "no-installation" ? (
      <DeployPullRequestDialog appId={app.id} repoBranch={view.branch} />
    ) : null;

  return (
    <div className="space-y-4">
      {/**
       * The same heading shape as Domains and Environment next door: a section title
       * inside the app, not a page title.
       */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Pull request previews</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Every open pull request against {view.branch} gets its own deploy
            and its own URL.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SettingsShortcut
            href={`/apps/${slug}/settings/pull-requests`}
            label="Pull request settings"
          />
          {deployButton}
        </div>
      </div>

      {view.unavailable === "not-github" && (
        <EmptyState
          icon={GitPullRequest}
          title="Pull request previews need a GitHub repository"
          docs="previews.overview"
          description="This app does not deploy from a connected GitHub repository, so Deplo never receives its pull requests."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={`/apps/${slug}/settings/pull-requests`}>
                Deploy source settings
              </Link>
            </Button>
          }
        />
      )}

      {view.unavailable === "no-installation" && (
        <EmptyState
          icon={GitHubIcon}
          title="This app is not connected to a GitHub App"
          docs="git.github"
          description="Deplo needs a connected GitHub App to receive pull request events for this repository."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/git">Git settings</Link>
            </Button>
          }
        />
      )}

      {view.unavailable === "app-needs-update" && (
        <div className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-4">
          <p className="text-sm font-medium">
            Your GitHub App cannot see pull requests yet
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Deplo needs the pull request event and permission to comment before
            it can build a preview when someone opens a pull request. It takes
            one click on GitHub. You can still deploy a pull request by hand
            from this page in the meantime.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {view.githubSettingsUrl && (
              <Button asChild size="sm">
                <a
                  href={view.githubSettingsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Update on GitHub
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/git">Git settings</Link>
            </Button>
          </div>
        </div>
      )}

      {view.unavailable === "disabled" && (
        <EmptyState
          graphic={<PullRequestGraphic variant="off" />}
          title="Pull request previews are off for this app"
          docs="previews.turnOn"
          description="Turn them on and every open pull request gets its own deploy with its own URL."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={`/apps/${slug}/settings/pull-requests`}>
                Deployment settings
              </Link>
            </Button>
          }
        />
      )}

      {(view.unavailable === null || view.unavailable === "app-needs-update") &&
        (view.previews.length === 0 ? (
          <EmptyState
            graphic={<PullRequestGraphic />}
            title="No pull request previews yet"
            docs="previews.overview"
            description={`Open a pull request against ${view.branch} and Deplo builds it a preview with its own URL, then posts the link on the pull request.`}
          />
        ) : (
          <PreviewsTable
            appSlug={slug}
            previews={view.previews}
            canDeploy={canDeploy}
            maxActive={view.maxActive}
          />
        ))}
    </div>
  );
}
