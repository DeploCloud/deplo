import { GitPullRequest } from "lucide-react";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { PullRequestGraphic } from "@/components/apps/previews/pull-request-graphic";

export function PreviewsNeedGithub({ slug }: { slug: string }) {
  return (
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
  );
}

export function PreviewsOff({ slug }: { slug: string }) {
  return (
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
  );
}
