import { notFound } from "next/navigation";
import { Rocket } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { listServersForCurrentTeam } from "@/lib/data/servers";
import { listGithubInstallations } from "@/lib/data/github";
import { listAppPreviews } from "@/lib/data/previews";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DeploymentSettingsForm } from "@/components/apps/settings/deployment-settings-form";
import { PreviewSettingsCard } from "@/components/apps/settings/preview-settings-card";

export const metadata = { title: "Deployment" };

export default async function AppDeploymentSettingsPage(
  props: PageProps<"/apps/[slug]/settings/deployments">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const servers = (await listServersForCurrentTeam()).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
  }));
  const installations = await listGithubInstallations();
  // The preview card only makes sense for a GitHub-backed app: nothing else
  // ever receives a `pull_request` delivery.
  const previews =
    project.source === "github" ? await listAppPreviews(project.id) : null;

  return (
    <section className="space-y-4">
      <SettingsSection icon={Rocket} title="Deployment" />
      <DeploymentSettingsForm
        appId={project.id}
        slug={project.slug}
        build={project.build}
        framework={project.framework}
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
      />
      {previews && (
        <PreviewSettingsCard
          appId={project.id}
          branch={previews.branch}
          enabled={previews.enabled}
          baseDomain={previews.baseDomain}
          maxActive={previews.maxActive}
          ttlDays={previews.ttlDays}
          forkPolicy={previews.forkPolicy}
        />
      )}
    </section>
  );
}
