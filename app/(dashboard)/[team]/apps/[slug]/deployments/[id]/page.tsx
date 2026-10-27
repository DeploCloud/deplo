import Link from "@/components/ui/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { hasAppCapability } from "@/lib/data/node-access";
import { EmptyState } from "@/components/shared/empty-state";
import {
  getLogs,
  getQueuePosition,
} from "@/lib/data/deployments/build-progress";
import {
  getDeployment,
  isFirstDeployment,
} from "@/lib/data/deployments/deployment-queries";
import { listDomains } from "@/lib/data/domains/crud";
import { Button } from "@/components/ui/button";
import {
  githubPullRequestUrl,
  gitProfileUrl,
  repoCommitUrl,
} from "@/lib/utils";
import { FirstDeployCelebration } from "@/components/apps/first-deploy-celebration";
import { DeploymentCover } from "@/components/apps/deployment-cover";
import { getDeploymentScreenshot } from "@/lib/data/deployments/screenshot";
import { describeAppSource } from "@/components/apps/app-source";
import { FrameworkBadge } from "@/components/apps/framework-badge";
import { DeploymentSections } from "@/components/apps/deployment-sections";
import {
  DeploymentDetailsCard,
  DeploymentDomainList,
  DeploymentShortcuts,
  DeploymentDomainsMeta,
  DeploymentSummary,
  type DeploymentDomain,
} from "@/components/apps/deployment-details";
import {
  effectiveFramework,
  supportsFrameworkDetection,
} from "@/lib/apps/framework-catalog";
import { BUILD_METHOD_NAMES } from "@/lib/apps/build-method";

export const metadata = { title: "Deployment" };

export default async function DeploymentDetailPage(
  props: PageProps<"/[team]/apps/[slug]/deployments/[id]">,
) {
  const { slug, id } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  const deployment = await getDeployment(id);
  if (!deployment || deployment.appId !== project.id) notFound();

  const [
    canReadLogs,
    canRollbackApps,
    canConfigure,
    canMetrics,
    canConsole,
    canEnv,
  ] = await Promise.all([
    hasAppCapability(project.id, "view_logs"),
    hasAppCapability(project.id, "rollback_apps"),
    hasAppCapability(project.id, "configure_apps"),
    hasAppCapability(project.id, "view_metrics"),
    hasAppCapability(project.id, "open_app_console"),
    hasAppCapability(project.id, "manage_env"),
  ]);
  const logs = canReadLogs ? await getLogs(id) : [];
  const queuePosition = await getQueuePosition(id);
  const firstEver = await isFirstDeployment(deployment);
  const shot = await getDeploymentScreenshot(id);
  const source = describeAppSource(project);
  const framework =
    (supportsFrameworkDetection(project.build.buildMethod) &&
      effectiveFramework(project)) ||
    null;

  // Addresses only on the build that answers them now; an older one would point elsewhere.
  const domains: DeploymentDomain[] = !deployment.live
    ? []
    : deployment.previewId
      ? [{ host: deployment.url.replace(/^https?:\/\//, ""), status: null }]
      : (await listDomains(project.id))
          .filter((d) => !d.redirectTo)
          .map((d) => ({
            host:
              d.name +
              (d.pathPrefix && d.pathPrefix !== "/" ? d.pathPrefix : ""),
            // Same reading as the Domains page: a proxy answering for it is not a fault.
            status: d.proxied && d.status !== "valid" ? "cloudflare" : d.status,
          }));

  const settings = [
    ...(source.isGit
      ? [
          {
            label: "Deploy on push",
            on: project.autoDeploy,
            href: "/settings/deployments",
          },
        ]
      : []),
    ...(project.source === "github"
      ? [
          {
            label: "Deploy pull requests",
            on: project.previewEnabled,
            href: "/settings/pull-requests",
          },
        ]
      : []),
    {
      label: "Health check",
      on: project.healthCheck != null,
      href: "/settings/advanced",
    },
    {
      label: "Restart loop protection",
      on: project.restartLoopGuard,
      href: "/settings/advanced",
    },
  ];

  return (
    <div className="space-y-4">
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

      <DeploymentDetailsCard
        slug={slug}
        deployment={deployment}
        cover={
          shot && (
            <DeploymentCover
              deploymentId={deployment.id}
              href={deployment.url}
              lightUrl={shot.lightUrl}
              darkUrl={shot.darkUrl}
              canRetake={shot.current && canConfigure}
            />
          )
        }
        source={source}
        prUrl={githubPullRequestUrl(project.repo, deployment.prNumber)}
        commitUrl={repoCommitUrl(project.repo, deployment.commitSha)}
        creatorUrl={gitProfileUrl(
          deployment.creatorProvider,
          deployment.creator,
          project.repo?.url,
        )}
        domains={domains}
        settings={settings}
        canRollbackApps={canRollbackApps}
      />

      <DeploymentSections
        deploymentId={id}
        status={deployment.status}
        startedAt={deployment.startedAt}
        buildDurationMs={deployment.buildDurationMs}
        queuePosition={queuePosition}
        logs={logs}
        logsLocked={
          canReadLogs ? null : (
            <EmptyState
              icon={Lock}
              title="No access to logs"
              docs="roles.floorCeiling"
              description="You don't have permission to read this app's logs. Ask a team admin for the “View logs” permission."
            />
          )
        }
        summary={
          <DeploymentSummary
            framework={framework}
            method={BUILD_METHOD_NAMES[project.build.buildMethod]}
            serverName={deployment.serverName}
            buildServerName={deployment.buildServerName}
          />
        }
        summaryMeta={
          framework && (
            <FrameworkBadge id={framework} className="text-muted-foreground" />
          )
        }
        domains={
          domains.length > 0 && (
            <DeploymentDomainList
              slug={slug}
              domains={domains}
              manageHref={deployment.previewId ? "/pull-requests" : "/domains"}
            />
          )
        }
        domainsMeta={<DeploymentDomainsMeta domains={domains} />}
      />

      <DeploymentShortcuts
        slug={slug}
        show={{
          logs: canReadLogs,
          monitoring: canMetrics,
          console: project.consoleEnabled && canConsole,
          environment: canEnv,
        }}
      />

      {firstEver && <FirstDeployCelebration status={deployment.status} />}
    </div>
  );
}
