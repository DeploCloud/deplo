import type { Metadata } from "next";
import { logoSrc } from "@/lib/apps/logo-src";
import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { appCapabilities } from "@/lib/data/node-access";
import { rollbackTarget } from "@/lib/data/deployments/rollback";
import { screenshotCapturedAt } from "@/lib/data/deployments/screenshot";
import {
  appBuildsItsOwnImage,
  appTypeLabel,
  repoWebUrl,
  truncate,
} from "@/lib/utils";
import { AppCapabilitiesProvider } from "@/components/apps/app-capabilities";
import { AppLogo } from "@/components/shared/project-logo";
import { LogoEditLink } from "@/components/shared/logo-edit-link";
import { RedeployButton } from "@/components/apps/redeploy-button";
import { AppRollbackButton } from "@/components/apps/rollback-deployment";
import { AppLifecycleButtons } from "@/components/apps/app-lifecycle";
import { AppControls } from "@/components/apps/app-controls";
import { AppStatusBadge } from "@/components/apps/app-status-dot";
import { AppNavSync } from "@/components/apps/app-nav-sync";
import { DetailFrame } from "@/components/layout/detail-frame";
import {
  AppLiveStatusProvider,
  type LiveApp,
} from "@/components/apps/app-live-status";
import { AppHeader } from "@/components/apps/app-header";
import { AppRenameProvider, AppTitle } from "@/components/apps/app-title";
import { WaitingForRoom } from "@/components/shared/waiting-for-room";
import { appWaitingNote } from "@/lib/data/clusters/placement";
import { getAppRuntime } from "@/lib/data/console";
import { experiments } from "@/lib/data/experiments";

const PROJECT_TITLE_MAX = 24;

// Streamed, never awaited: the page shows at once and the containers' state follows when the agent answers.
async function runtimeSeed(appId: string) {
  const value = await Promise.race([
    getAppRuntime(appId).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 2_000)),
  ]);
  return value ? { at: Date.now(), value } : null;
}

export async function generateMetadata(
  props: LayoutProps<"/[team]/apps/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug).catch(() => null);
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
  const buildsOwnImage = appBuildsItsOwnImage(project);
  const logo = logoSrc("app", project.id, project.logo);
  const [capabilities, rollback, latestScreenshotAt, waiting, flags] =
    await Promise.all([
      appCapabilities(project.id),
      buildsOwnImage ? rollbackTarget(project.id) : null,
      project.latestDeployment
        ? screenshotCapturedAt(project.latestDeployment.id)
        : null,
      appWaitingNote(project),
      experiments(),
    ]);

  const runtime = project.status === "active" ? runtimeSeed(project.id) : null;
  const initialLive: LiveApp = {
    id: project.id,
    slug: project.slug,
    status: project.status,
    productionUrl: project.productionUrl ?? null,
    restartLoopStoppedAt: project.restartLoopStoppedAt ?? null,
    restartsPausedAt: project.restartsPausedAt ?? null,
    latestDeploymentId: project.latestDeployment?.id ?? null,
    latestDeploymentStatus: project.latestDeployment?.status ?? null,
    latestScreenshotAt,
  };

  return (
    <AppLiveStatusProvider
      key={initialLive.slug}
      initial={initialLive}
      runtimeSeed={runtime}
    >
      <AppCapabilitiesProvider capabilities={capabilities}>
        <DetailFrame
          locked={Boolean(project.migrationRunId)}
          mobile={{
            root: `/apps/${slug}`,
            name: project.name,
            parent: { href: "/", label: "Overview" },
            nav: {
              slug,
              logo,
              running: project.status === "active",
              capabilities,
              isGithubApp: project.source === "github",
              previewsEnabled: project.previewEnabled && flags.pullRequests,
              pullRequestsOffered: flags.pullRequests,
              cronsEnabled: project.cronEnabled && flags.crons,
              consoleEnabled: project.consoleEnabled,
            },
          }}
          header={
            <AppRenameProvider appId={project.id} name={project.name}>
              <AppHeader
                logo={
                  <LogoEditLink
                    href={`/apps/${slug}/settings`}
                    label="General settings"
                  >
                    <AppLogo logo={logo} tone={project.logoTone} size={44} />
                  </LogoEditLink>
                }
                name={<AppTitle />}
                status={<AppStatusBadge status={project.status} />}
                subtitle={
                  waiting ? (
                    <WaitingForRoom note={waiting} />
                  ) : project.productionUrl ? (
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
                  )
                }
                actions={
                  <>
                    {buildsOwnImage ? (
                      <AppRollbackButton
                        slug={project.slug}
                        target={rollback}
                      />
                    ) : (
                      <AppLifecycleButtons
                        appId={project.id}
                        status={project.status}
                      />
                    )}
                    <RedeployButton
                      appId={project.id}
                      slug={project.slug}
                      variant="default"
                    />
                    <AppControls
                      appId={project.id}
                      slug={project.slug}
                      name={project.name}
                      status={project.status}
                      productionUrl={project.productionUrl ?? null}
                      repoUrl={repoWebUrl(project.repo)}
                      showLifecycle={buildsOwnImage}
                    />
                  </>
                }
              />
            </AppRenameProvider>
          }
          sidecars={
            <AppNavSync
              slug={slug}
              logo={logo}
              running={project.status === "active"}
              capabilities={capabilities}
              isGithubApp={project.source === "github"}
              previewsEnabled={project.previewEnabled && flags.pullRequests}
              pullRequestsOffered={flags.pullRequests}
              cronsEnabled={project.cronEnabled && flags.crons}
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
