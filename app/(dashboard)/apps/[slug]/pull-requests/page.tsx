import { notFound } from "next/navigation";
import Link from "next/link";
import { ExternalLink, GitPullRequest } from "lucide-react";

import { getAppBySlug } from "@/lib/data/apps";
import { listAppPreviews } from "@/lib/data/previews";
import { hasCapability } from "@/lib/membership";
import { GitHubIcon } from "@/components/shared/brand-icons";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { DeployPullRequestDialog } from "@/components/apps/previews/deploy-pull-request-dialog";
import { PreviewsTable } from "@/components/apps/previews/previews-table";

export const metadata = { title: "Pull requests" };

/**
 * Pull request previews for one app.
 *
 * The whole page is a switch on ONE server-resolved reason, so a user is never
 * left guessing why nothing is building: not a GitHub app, no installation, the
 * GitHub App is not subscribed to pull request events, or previews are simply
 * off. Each case names the fix and links straight to it.
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
    canDeploy && view.unavailable !== "not-github" && view.unavailable !== "no-installation" ? (
      <DeployPullRequestDialog appId={app.id} repoBranch={view.branch} />
    ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pull request previews"
        description={`Every open pull request against ${view.branch} gets its own deploy and its own URL.`}
        actions={deployButton}
      />

      {view.unavailable === "not-github" && (
        <EmptyState
          icon={GitPullRequest}
          title="Pull request previews need a GitHub repository"
          description="This app does not deploy from a connected GitHub repository, so Deplo never receives its pull requests."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={`/apps/${slug}/settings/deployments`}>
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
            one click on GitHub. You can still deploy a pull request by hand from
            this page in the meantime.
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
          icon={GitPullRequest}
          title="Pull request previews are off for this app"
          description="Turn them on and every open pull request gets its own deploy with its own URL."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={`/apps/${slug}/settings/deployments`}>
                Deployment settings
              </Link>
            </Button>
          }
        />
      )}

      {(view.unavailable === null || view.unavailable === "app-needs-update") &&
        (view.previews.length === 0 ? (
          <EmptyState
            icon={GitPullRequest}
            title="No pull request previews yet"
            description={`Open a pull request against ${view.branch} and Deplo builds it a preview with its own URL, then posts the link on the pull request.`}
            action={deployButton}
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
