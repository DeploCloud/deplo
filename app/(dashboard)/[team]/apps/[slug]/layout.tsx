import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { appCapabilities } from "@/lib/data/node-access";
import { rollbackTarget } from "@/lib/data/deployments/rollback";
import { appTypeLabel, repoWebUrl, truncate } from "@/lib/utils";
import { AppCapabilitiesProvider } from "@/components/apps/app-capabilities";
import { AppLogo } from "@/components/shared/project-logo";
import { LogoEditLink } from "@/components/shared/logo-edit-link";
import { RedeployButton } from "@/components/apps/redeploy-button";
import { AppRollbackButton } from "@/components/apps/rollback-deployment";
import { AppControls } from "@/components/apps/app-controls";
import { AppStatusBadge } from "@/components/apps/app-status-dot";
import { AppNavSync } from "@/components/apps/app-nav-sync";
import { DetailFrame } from "@/components/layout/detail-frame";
import {
  AppLiveStatusProvider,
  type LiveApp,
} from "@/components/apps/app-live-status";
import { titleClass } from "@/components/shared/page-header";

const PROJECT_TITLE_MAX = 24;

export async function generateMetadata(
  props: LayoutProps<"/[team]/apps/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) return { title: "App" };
  const name = truncate(project.name, PROJECT_TITLE_MAX);
  return {
    title: {
      template: `${name} - %s - Deplo`,
      default: `${name} - Overview - Deplo`,
    },
  };
}

export default async function AppLayout(
  props: LayoutProps<"/[team]/apps/[slug]">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project || project.deletingAt) notFound();
  const [capabilities, rollback] = await Promise.all([
    appCapabilities(project.id),
    rollbackTarget(project.id),
  ]);

  const initialLive: LiveApp = {
    id: project.id,
    slug: project.slug,
    status: project.status,
    productionUrl: project.productionUrl ?? null,
    restartLoopStoppedAt: project.restartLoopStoppedAt ?? null,
    latestDeploymentId: project.latestDeployment?.id ?? null,
    latestDeploymentStatus: project.latestDeployment?.status ?? null,
  };

  return (
    <AppLiveStatusProvider key={initialLive.slug} initial={initialLive}>
      <AppCapabilitiesProvider capabilities={capabilities}>
        <DetailFrame
          locked={Boolean(project.migrationRunId)}
          header={
            <div>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <LogoEditLink
                    href={`/apps/${slug}/settings`}
                    label="General settings"
                  >
                    <AppLogo
                      logo={project.logo}
                      tone={project.logoTone}
                      size={44}
                    />
                  </LogoEditLink>
                  <div>
                    <div className="flex items-center gap-2">
                      <h1 className={titleClass.page}>{project.name}</h1>
                      <AppStatusBadge status={project.status} />
                    </div>
                    {project.productionUrl ? (
                      <a
                        href={project.productionUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                      >
                        {project.productionUrl.replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {appTypeLabel(project)}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <RedeployButton
                    appId={project.id}
                    slug={project.slug}
                    variant="default"
                  />
                  <AppRollbackButton slug={project.slug} target={rollback} />
                  <AppControls
                    appId={project.id}
                    slug={project.slug}
                    name={project.name}
                    status={project.status}
                    productionUrl={project.productionUrl ?? null}
                    repoUrl={repoWebUrl(project.repo)}
                  />
                </div>
              </div>
            </div>
          }
          sidecars={
            <AppNavSync
              slug={slug}
              logo={project.logo}
              running={project.status === "active"}
              capabilities={capabilities}
              isGithubApp={project.source === "github"}
              previewsEnabled={project.previewEnabled}
              cronsEnabled={project.cronEnabled}
              consoleEnabled={project.consoleEnabled}
            />
          }
        >
          {props.children}
        </DetailFrame>
      </AppCapabilitiesProvider>
    </AppLiveStatusProvider>
  );
}
