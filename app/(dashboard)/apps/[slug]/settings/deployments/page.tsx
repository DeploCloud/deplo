import { notFound } from "next/navigation";
import { Rocket } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { deployHookUrlMasked } from "@/lib/data/deploy-hook";
import { listServerChoices } from "@/lib/data/servers";
import { listGithubInstallations } from "@/lib/data/github";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DeploymentSettingsForm } from "@/components/apps/settings/deployment-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";

export const metadata = { title: "Deployment" };

export default async function AppDeploymentSettingsPage(
  props: PageProps<"/apps/[slug]/settings/deployments">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const servers = await listServerChoices();
  const installations = await listGithubInstallations();

  return (
    <section className="space-y-4">
      <SettingsSection icon={Rocket} title="Deployment" />
      <CapabilityFieldset cap="configure_apps">
        <DeploymentSettingsForm
          appId={project.id}
          slug={project.slug}
          build={project.build}
          framework={project.framework}
          frameworkOverride={project.frameworkOverride}
          autoDeploy={project.autoDeploy}
          source={project.source}
          repo={project.repo}
          dockerImage={project.dockerImage}
          upload={
            project.upload
              ? {
                  filename: project.upload.filename,
                  size: project.upload.size,
                  uploadedAt: project.upload.uploadedAt,
                }
              : null
          }
          compose={project.compose}
          serverId={project.serverId}
          servers={servers}
          installations={installations}
          deployHookEnabled={project.deployHookEnabled}
          composeUpArgs={project.composeUpArgs}
          // The link's shape, never its token: the real URL is fetched only when
          // someone with `configure_apps` deliberately reveals it. An app that
          // deploys from a git provider is already triggered by that provider, so
          // it gets no deploy hook in the UI at all - and null here keeps its link
          // out of the page payload entirely, rather than merely hiding it.
          deployHookUrlMasked={
            project.source === "github" || project.source === "git"
              ? null
              : await deployHookUrlMasked(project.id)
          }
        />
      </CapabilityFieldset>
    </section>
  );
}
