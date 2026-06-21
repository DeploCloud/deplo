import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, ArrowLeft } from "lucide-react";
import { getProjectBySlug } from "@/lib/data/projects";
import { isDevEligible } from "@/lib/data/dev";
import { hasCapability } from "@/lib/membership";
import { Button } from "@/components/ui/button";
import { ProjectLogo } from "@/components/shared/project-logo";
import { RedeployButton } from "@/components/projects/redeploy-button";
import { ProjectControls } from "@/components/projects/project-controls";
import { ProjectStatusDot } from "@/components/projects/project-status-dot";
import { ProjectTabs } from "@/components/projects/project-tabs";
import {
  ProjectLiveStatusProvider,
  type LiveProject,
} from "@/components/projects/project-live-status";

export default async function ProjectLayout(props: LayoutProps<"/projects/[slug]">) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const canManageEnv = await hasCapability("manage_env");

  // Seed for the live-status subscription (kept current client-side thereafter).
  const initialLive: LiveProject = {
    id: project.id,
    slug: project.slug,
    status: project.status,
    productionUrl: project.productionUrl ?? null,
    latestDeploymentStatus: project.latestDeployment?.status ?? null,
  };

  return (
    <ProjectLiveStatusProvider key={initialLive.slug} initial={initialLive}>
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
            Projects
          </Link>
        </Button>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <ProjectLogo
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
                  <ProjectStatusDot status={project.status} />
                  {project.productionUrl.replace(/^https?:\/\//, "")}
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {project.productionUrl && (
              <Button variant="outline" size="sm" asChild>
                <a
                  href={project.productionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="size-4" />
                  Visit
                </a>
              </Button>
            )}
            <ProjectControls projectId={project.id} status={project.status} />
            <RedeployButton projectId={project.id} />
          </div>
        </div>
      </div>

      <ProjectTabs
        slug={slug}
        running={project.status === "active"}
        devEligible={isDevEligible(project.source)}
        canManageEnv={canManageEnv}
      />

      {props.children}
    </div>
    </ProjectLiveStatusProvider>
  );
}
