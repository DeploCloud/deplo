import { Suspense } from "react";
import { AppDomainNotices } from "@/components/domains/app-domain-notices";
import { SecurityUpdatesNotice } from "@/components/security-updates/security-updates-notice";
import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { hasAppCapability } from "@/lib/data/node-access";
import { DataCopyNotice } from "@/components/shared/data-copy-notice";
import { listDeployments } from "@/lib/data/deployments/deployment-queries";
import { getAppCoverScreenshot } from "@/lib/data/deployments/screenshot";
import { ProductionDeploymentCard } from "@/components/apps/production-deployment-card";
import { RepoLinkNotice } from "@/components/apps/repo-link-notice";
import { repoCredentialMissing } from "@/lib/utils";
import { RecentDeployments } from "@/components/apps/recent-deployments";

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

      <RecentDeployments slug={slug} deployments={deployments} />
    </div>
  );
}
