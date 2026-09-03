import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  GitBranch,
  GitPullRequest,
  Clock,
  ExternalLink,
  Lock,
} from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { hasAppCapability } from "@/lib/data/node-access";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploymentCreator } from "@/components/apps/deployment-creator";
import {
  getDeployment,
  getLogs,
  getQueuePosition,
  isFirstDeployment,
} from "@/lib/data/deployments";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { CommitLink } from "@/components/apps/commit-link";
import { CommitMessage } from "@/components/apps/commit-message";
import {
  githubPullRequestUrl,
  gitProfileUrl,
  repoCommitUrl,
} from "@/lib/utils";
import { BuildLogStream } from "@/components/apps/build-log-stream";
import { BuildDuration } from "@/components/apps/build-duration";
import { RollbackButton } from "@/components/apps/rollback-deployment";
import { FirstDeployCelebration } from "@/components/apps/first-deploy-celebration";
import { TimeAgo } from "@/components/shared/time-ago";

export const metadata = { title: "Deployment" };

export default async function DeploymentDetailPage(
  props: PageProps<"/apps/[slug]/deployments/[id]">,
) {
  const { slug, id } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  const deployment = await getDeployment(id);
  if (!deployment || deployment.appId !== project.id) notFound();

  // Build logs print the app's build-time variables, so they are their own
  // permission, held per app (ADR-0016).
  const canReadLogs = await hasAppCapability(project.id, "view_logs");
  // NOT the same question as `deployment.canRollback`, which is whether this
  // build is still a target at all. This is whether the VIEWER may take it.
  const canRollbackApps = await hasAppCapability(project.id, "rollback_apps");
  const logs = canReadLogs ? await getLogs(id) : [];
  // Its live slot in the owning server's build queue (null unless still queued),
  // so the "in queue" banner paints its position without waiting on the first poll.
  const queuePosition = await getQueuePosition(id);
  const prUrl = githubPullRequestUrl(project.repo, deployment.prNumber);
  // Confetti is for the app's very first build, and only when it lands.
  const firstEver = await isFirstDeployment(deployment);

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        asChild
        className="-ml-2 text-muted-foreground"
      >
        <Link href={`/apps/${slug}/deployments`}>
          <ArrowLeft className="size-4" />
          Back to deployments
        </Link>
      </Button>

      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Meta label="Status">
            <StatusBadge status={deployment.status} />
          </Meta>
          {/* Only a pull request preview has anything to say here: a production
              build is what every other deployment is. */}
          {deployment.prNumber != null && (
            <Meta label="Pull request">
              <span className="flex items-center gap-1.5 text-sm">
                <GitPullRequest className="size-3.5" />
                {prUrl ? (
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    #{deployment.prNumber}
                  </a>
                ) : (
                  <span>#{deployment.prNumber}</span>
                )}
              </span>
            </Meta>
          )}
          <Meta label="Source">
            <span className="flex items-center gap-1.5 text-sm">
              <GitBranch className="size-3.5" />
              {deployment.branch}
              <CommitLink
                sha={deployment.commitSha}
                url={repoCommitUrl(project.repo, deployment.commitSha)}
                className="font-mono text-xs text-muted-foreground"
              />
            </span>
          </Meta>
          <Meta label="Build time">
            <span className="flex items-center gap-1.5 text-sm">
              <Clock className="size-3.5" />
              {/* Ticks live while the build runs, then freezes on the measured
                  duration - see BuildDuration. */}
              <BuildDuration
                status={deployment.status}
                startedAt={deployment.startedAt}
                buildDurationMs={deployment.buildDurationMs}
              />
            </span>
          </Meta>
          <Meta label="Commit" className="sm:col-span-2">
            <CommitMessage
              message={deployment.commitMessage}
              sha={deployment.commitSha}
            />
          </Meta>
          <Meta label="Created">
            {/* Each part its own flex item: contiguous text collapses into ONE,
                and "by" lost its space against the name whenever the avatar in
                between was not rendered. */}
            <span className="flex items-center gap-1.5 text-sm">
              <span>
                <TimeAgo at={deployment.createdAt} live /> by
              </span>
              <DeploymentCreator
                creator={deployment.creator}
                creatorUser={deployment.creatorUser}
                creatorProvider={deployment.creatorProvider}
                creatorUrl={gitProfileUrl(
                  deployment.creatorProvider,
                  deployment.creator,
                  project.repo?.url,
                )}
              />
            </span>
          </Meta>
          <div className="flex items-end gap-2">
            {/* Only where the server says this build can still be re-run: its
                image has to be on the app's current host and not already live. */}
            {deployment.canRollback && (
              <RollbackButton
                id={deployment.id}
                appSlug={slug}
                commitSha={deployment.commitSha}
                commitMessage={deployment.commitMessage}
                can={canRollbackApps}
              />
            )}
            <Button variant="outline" size="sm" asChild>
              <a
                href={deployment.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="size-4" />
                Visit
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <p className="text-sm font-medium">Build Logs</p>
        {canReadLogs ? (
          <BuildLogStream
            deploymentId={id}
            initialLogs={logs}
            initialStatus={deployment.status}
            initialQueuePosition={queuePosition}
            initialStartedAt={deployment.startedAt}
            initialBuildDurationMs={deployment.buildDurationMs}
          />
        ) : (
          <EmptyState
            icon={Lock}
            title="No access to logs"
            docs="roles.floorCeiling"
            description="You don't have permission to read this app's logs. Ask a team admin for the “View logs” permission."
          />
        )}
      </div>

      {firstEver && <FirstDeployCelebration status={deployment.status} />}
    </div>
  );
}

function Meta({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}
