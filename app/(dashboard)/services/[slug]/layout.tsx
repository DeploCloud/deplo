import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, ArrowLeft } from "lucide-react";
import { getServiceBySlug } from "@/lib/data/services";
import { truncate } from "@/lib/utils";
import { isDevEligible } from "@/lib/data/dev";
import { serviceFilesExist } from "@/lib/data/service-files";
import { hasCapability } from "@/lib/membership";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ServiceLogo } from "@/components/shared/project-logo";
import { RedeployButton } from "@/components/services/redeploy-button";
import { ServiceControls } from "@/components/services/service-controls";
import { ServiceStatusDot } from "@/components/services/service-status-dot";
import { ServiceTabs } from "@/components/services/service-tabs";
import {
  ServiceLiveStatusProvider,
  type LiveService,
} from "@/components/services/service-live-status";

// Cap the service-name portion of the browser-tab title so the trailing
// "– <Section> – Deplo" stays legible instead of a long name crowding it out.
const PROJECT_TITLE_MAX = 24;

// Titles nest as "<project> – <section> – Deplo". The section (%s) comes from
// each child tab's own `title` (Deployments, Environment, Domains, …); the
// Overview page sits in this same segment and has no title, so it inherits the
// `default` below. `title.template` here overrides the root "%s – Deplo".
export async function generateMetadata(
  props: LayoutProps<"/services/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) return { title: "Service" };
  const name = truncate(project.name, PROJECT_TITLE_MAX);
  return {
    title: {
      template: `${name} – %s – Deplo`,
      default: `${name} – Overview – Deplo`,
    },
  };
}

export default async function ServiceLayout(props: LayoutProps<"/services/[slug]">) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();
  const canManageEnv = await hasCapability("manage_env");
  // Backups are infra ops (provision a dump, overwrite-restore in place), gated
  // on manage_infra — same capability the GraphQL mutations enforce.
  const canBackup = await hasCapability("manage_infra");
  // The Files tab only appears when the caller can manage files AND the service
  // actually has an on-disk files dir (serviceFilesExist returns false for both
  // a missing capability and a missing directory, so this one call covers both).
  const showFiles = await serviceFilesExist(project.id);

  // Seed for the live-status subscription (kept current client-side thereafter).
  const initialLive: LiveService = {
    id: project.id,
    slug: project.slug,
    status: project.status,
    productionUrl: project.productionUrl ?? null,
    latestDeploymentStatus: project.latestDeployment?.status ?? null,
  };

  return (
    <ServiceLiveStatusProvider key={initialLive.slug} initial={initialLive}>
    <div className="space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="mb-3 -ml-2 text-muted-foreground"
        >
          <Link href="/">
            <ArrowLeft className="size-4" />
            Services
          </Link>
        </Button>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <ServiceLogo
              logo={project.logo}
              framework={project.framework}
              size={44}
            />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                {project.name}
              </h1>
              {project.productionUrl && (
                <a
                  href={project.productionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ServiceStatusDot status={project.status} />
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
            <ServiceControls serviceId={project.id} status={project.status} />
            <RedeployButton serviceId={project.id} variant="default" />
          </div>
        </div>
      </div>

      <ServiceTabs
        slug={slug}
        running={project.status === "active"}
        devEligible={isDevEligible(project.source)}
        canManageEnv={canManageEnv}
        showFiles={showFiles}
        canBackup={canBackup}
      />

      {props.children}
    </div>
    </ServiceLiveStatusProvider>
  );
}
