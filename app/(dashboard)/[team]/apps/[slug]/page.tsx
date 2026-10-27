import { Suspense } from "react";
import { AppDomainNotices } from "@/components/domains/app-domain-notices";
import { SecurityUpdatesNotice } from "@/components/security-updates/security-updates-notice";
import Link from "@/components/ui/link";
import { notFound } from "next/navigation";
import { GitBranch, GitPullRequest, ArrowRight } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { hasAppCapability } from "@/lib/data/node-access";
import { DataCopyNotice } from "@/components/shared/data-copy-notice";
import { listDeployments } from "@/lib/data/deployments/deployment-queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploymentGraphic } from "@/components/apps/deployment-graphic";
import { getAppCoverScreenshot } from "@/lib/data/deployments/screenshot";
import { ProductionDeploymentCard } from "@/components/apps/production-deployment-card";
import { RepoLinkNotice } from "@/components/apps/repo-link-notice";
import { CommitLink } from "@/components/apps/commit-link";
import {
  formatBuildDuration,
  repoCredentialMissing,
  timeAgoShort,
} from "@/lib/utils";
import { titleClass } from "@/components/shared/page-header";

export default async function AppOverview(
  props: PageProps<"/[team]/apps/[slug]">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const deployments = await listDeployments({ appId: project.id });
  const canDeploy = await hasAppCapability(project.id, "deploy_apps");
  const prod =
    deployments.find((d) => d.id === project.latestDeployment?.id) ??
    project.latestDeployment;
  const [shot, canConfigure] = await Promise.all([
    prod ? getAppCoverScreenshot(project.id) : null,
    hasAppCapability(project.id, "configure_apps"),
  ]);

  return (
    <div className="space-y-6">
      <DataCopyNotice
        kind="app"
        id={project.id}
        name={project.name}
        error={project.dataCopyError}
        canAccept={canDeploy}
        move={Boolean(project.migrateFromServerId)}
      />

      {repoCredentialMissing(project) && project.repo && (
        <RepoLinkNotice
          slug={slug}
          repoName={project.repo.repo || project.repo.url}
        />
      )}

      <Suspense fallback={null}>
        <AppDomainNotices app={project} />
      </Suspense>

      <Suspense fallback={null}>
        <SecurityUpdatesNotice
          kind="app"
          id={project.id}
          slug={slug}
          name={project.name}
        />
      </Suspense>

      <ProductionDeploymentCard
        project={project}
        prod={prod}
        shot={shot}
        canConfigure={canConfigure}
      />

      <div id="deployments" className="space-y-3">
        <div className="flex flex-row items-center justify-between">
          <h2 className={titleClass.section}>Deployments</h2>
          {deployments.length > 4 && (
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
          )}
        </div>
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
                className="flex cursor-pointer items-center gap-4 border-b border-border px-4 py-3 last:border-0 hover:bg-surface"
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
      </div>
    </div>
  );
}
