import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { truncate } from "@/lib/utils";
import { isDevEligible } from "@/lib/data/dev";
import { appFilesExist } from "@/lib/data/app-files";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { AppLogo } from "@/components/shared/project-logo";
import { RedeployButton } from "@/components/apps/redeploy-button";
import { AppControls } from "@/components/apps/app-controls";
import { AppStatusBadge } from "@/components/apps/app-status-dot";
import { AppNavSync } from "@/components/apps/app-nav-sync";
import {
  AppLiveStatusProvider,
  type LiveApp,
} from "@/components/apps/app-live-status";

// Cap the app-name portion of the browser-tab title so the trailing
// "– <Section> – Deplo" stays legible instead of a long name crowding it out.
const PROJECT_TITLE_MAX = 24;

// Titles nest as "<project> – <section> – Deplo". The section (%s) comes from
// each child tab's own `title` (Deployments, Environment, Domains, …); the
// Overview page sits in this same segment and has no title, so it inherits the
// `default` below. `title.template` here overrides the root "%s – Deplo".
export async function generateMetadata(
  props: LayoutProps<"/apps/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) return { title: "App" };
  const name = truncate(project.name, PROJECT_TITLE_MAX);
  return {
    title: {
      template: `${name} – %s – Deplo`,
      default: `${name} – Overview – Deplo`,
    },
  };
}

export default async function AppLayout(props: LayoutProps<"/apps/[slug]">) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  // The Files entry only appears when the caller can manage files AND the app
  // actually has an on-disk files dir (appFilesExist returns false for both
  // a missing capability and a missing directory, so this one call covers both).
  // Environment/Backups visibility is capability-gated in the sidebar itself.
  const showFiles = await appFilesExist(project.id);

  // Seed for the live-status subscription (kept current client-side thereafter).
  const initialLive: LiveApp = {
    id: project.id,
    slug: project.slug,
    status: project.status,
    productionUrl: project.productionUrl ?? null,
    latestDeploymentId: project.latestDeployment?.id ?? null,
    latestDeploymentStatus: project.latestDeployment?.status ?? null,
  };

  return (
    <AppLiveStatusProvider key={initialLive.slug} initial={initialLive}>
    <div className="space-y-6">
      <div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <AppLogo logo={project.logo} size={44} />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">
                  {project.name}
                </h1>
                {/* The live container lifecycle (Running / Stopped / Building /
                    Error) — the header's headline status, distinct from any
                    deployment status shown further down the page. */}
                <AppStatusBadge status={project.status} />
              </div>
              {project.productionUrl && (
                <a
                  href={project.productionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  {project.productionUrl.replace(/^https?:\/\//, "")}
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {project.productionUrl && (
              <SimpleTooltip content="Open the live site in a new tab">
                <Button variant="default" size="sm" asChild>
                  <a
                    href={project.productionUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="size-4" />
                    Visit
                  </a>
                </Button>
              </SimpleTooltip>
            )}
            <AppControls appId={project.id} status={project.status} />
            <RedeployButton
              appId={project.id}
              slug={project.slug}
              variant="default"
            />
          </div>
        </div>
      </div>

      {/* Publishes this app's live/per-app facts to the sidebar, which
          renders the app sub-menu in place of the main nav. Renders nothing. */}
      <AppNavSync
        slug={slug}
        running={project.status === "active"}
        devEligible={isDevEligible(project.source)}
        showFiles={showFiles}
      />

      {props.children}
    </div>
    </AppLiveStatusProvider>
  );
}
