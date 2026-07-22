import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, GitBranch, Clock, ExternalLink } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import {
  getDeployment,
  getLogs,
  getQueuePosition,
} from "@/lib/data/deployments";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { CommitLink } from "@/components/apps/commit-link";
import { githubCommitUrl, timeAgo } from "@/lib/utils";
import { BuildLogStream } from "@/components/apps/build-log-stream";
import { BuildDuration } from "@/components/apps/build-duration";

export const metadata = { title: "Deployment" };

export default async function DeploymentDetailPage(
  props: PageProps<"/apps/[slug]/deployments/[id]">,
) {
  const { slug, id } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  const deployment = await getDeployment(id);
  if (!deployment || deployment.appId !== project.id) notFound();

  const logs = await getLogs(id);
  // Its live slot in the owning server's build queue (null unless still queued),
  // so the "in queue" banner paints its position without waiting on the first poll.
  const queuePosition = await getQueuePosition(id);

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        asChild
        className="-ml-2 text-muted-foreground"
      >
        <Link href={`/apps/${slug}`}>
          <ArrowLeft className="size-4" />
          Back to project
        </Link>
      </Button>

      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Meta label="Status">
            <StatusBadge status={deployment.status} />
          </Meta>
          <Meta label="Environment">
            <Badge
              variant={
                deployment.environment === "production"
                  ? "default"
                  : "secondary"
              }
            >
              {deployment.environment}
            </Badge>
          </Meta>
          <Meta label="Source">
            <span className="flex items-center gap-1.5 text-sm">
              <GitBranch className="size-3.5" />
              {deployment.branch}
              <CommitLink
                sha={deployment.commitSha}
                url={githubCommitUrl(project.repo, deployment.commitSha)}
                className="font-mono text-xs text-muted-foreground"
              />
            </span>
          </Meta>
          <Meta label="Build time">
            <span className="flex items-center gap-1.5 text-sm">
              <Clock className="size-3.5" />
              {/* Ticks live while the build runs, then freezes on the measured
                  duration — see BuildDuration. */}
              <BuildDuration
                status={deployment.status}
                startedAt={deployment.startedAt}
                buildDurationMs={deployment.buildDurationMs}
              />
            </span>
          </Meta>
          <div className="sm:col-span-2">
            <p className="text-xs text-muted-foreground">Commit</p>
            <p className="text-sm">{deployment.commitMessage}</p>
          </div>
          <Meta label="Created">
            <span className="text-sm">
              {timeAgo(deployment.createdAt)} by {deployment.creator}
            </span>
          </Meta>
          <div className="flex items-end">
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
        <BuildLogStream
          deploymentId={id}
          initialLogs={logs}
          initialStatus={deployment.status}
          initialQueuePosition={queuePosition}
          showQueueBanner
        />
      </div>
    </div>
  );
}

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}
