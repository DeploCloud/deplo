import Link from "@/components/ui/link";
import { ArrowRight, GitBranch, GitPullRequest } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bone, Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploymentGraphic } from "@/components/apps/deployment-graphic";
import { CommitLink } from "@/components/apps/commit-link";
import { titleClass } from "@/components/shared/page-header";
import { formatBuildDuration, timeAgoShort } from "@/lib/utils";
import type { listDeployments } from "@/lib/data/deployments/deployment-queries";

type DeploymentRow = Awaited<ReturnType<typeof listDeployments>>[number];

const ROW =
  "flex items-center gap-4 border-b border-border px-4 py-3 last:border-0";

function Section({
  seeAll,
  children,
}: {
  seeAll: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div id="deployments" className="space-y-3">
      <div className="flex flex-row items-center justify-between">
        <h2 className={titleClass.section}>Deployments</h2>
        {seeAll}
      </div>
      {children}
    </div>
  );
}

// The App overview's four latest deployments.
export function RecentDeployments({
  slug,
  deployments,
}: {
  slug: string;
  deployments: DeploymentRow[];
}) {
  return (
    <Section
      seeAll={
        deployments.length > 4 && (
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="-mr-2 text-muted-foreground hover:text-foreground"
          >
            <Link href={`/apps/${slug}/deployments`}>
              See all
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        )
      }
    >
      {deployments.length === 0 ? (
        <EmptyState
          graphic={<DeploymentGraphic />}
          title="No deployments yet"
          docs="deploy.trace"
          description="Deploy this app and every build lands here, with its logs."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {deployments.slice(0, 4).map((d) => (
            <Link
              key={d.id}
              href={`/apps/${slug}/deployments/${d.id}`}
              className={`${ROW} cursor-pointer hover:bg-surface`}
            >
              <StatusDot status={d.status} />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-sm font-medium">
                  {d.commitMessage}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CommitLink
                    sha={d.commitSha}
                    url={d.commitUrl}
                    signature={d.commitSignature}
                    className="font-mono"
                  />
                  <GitBranch className="size-3" />
                  {d.branch}
                </p>
              </div>
              {d.prNumber != null && (
                <Badge
                  variant="outline"
                  className="hidden gap-1 font-normal sm:inline-flex"
                >
                  <GitPullRequest className="size-3" />
                  {d.prNumber}
                </Badge>
              )}
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {formatBuildDuration(d.buildDurationMs)}
              </span>
              <span className="text-xs text-muted-foreground">
                {timeAgoShort(d.createdAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}

export function RecentDeploymentsSkeleton() {
  return (
    <Section
      seeAll={
        <Bone box className="-mr-2">
          <Button variant="ghost" size="sm" disabled>
            See all
            <ArrowRight className="size-4" />
          </Button>
        </Bone>
      }
    >
      <div className="overflow-hidden rounded-xl border border-border">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={ROW}>
            <Skeleton className="size-2.5 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-sm font-medium">
                <Bone>Commit message of the build</Bone>
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Bone>a1b2c3d main</Bone>
              </p>
            </div>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              <Bone>1m 30s</Bone>
            </span>
            <span className="text-xs text-muted-foreground">
              <Bone>2d ago</Bone>
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}
