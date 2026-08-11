import { notFound } from "next/navigation";
import { Rocket } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { deployHookUrlMasked } from "@/lib/data/deploy-hook";
import { listServerChoices } from "@/lib/data/servers";
import { listGithubInstallations } from "@/lib/data/github";
import { appWebhookStatus, listGitConnections } from "@/lib/data/git-connections";
import { providerFor } from "@/lib/git/providers";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DeploymentSettingsForm } from "@/components/apps/settings/deployment-settings-form";
import { RollbackSettingsForm } from "@/components/apps/settings/rollback-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import { usesComposeStack } from "@/lib/utils";

export const metadata = { title: "Deployment" };

export default async function AppDeploymentSettingsPage(
  props: PageProps<"/apps/[slug]/settings/deployments">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const servers = await listServerChoices();
  const installations = await listGithubInstallations();
  const connections = await listGitConnections();

  // Does a git provider ALREADY trigger this app's deploys? Only then is the
  // deploy hook redundant. A bare Repository URL has no sender behind it, so
  // hiding its hook (as this page used to, for every `git` source) left it with
  // no automatic trigger at all and no way to make one.
  const providerTriggers =
    project.source === "github" ||
    (Boolean(project.repo?.connectionId) &&
      providerFor(project.repo?.provider ?? "git").api != null);

  // Whether the push webhook is actually registered on the provider right now,
  // asked of the provider rather than remembered: someone deleting it on their
  // side is exactly the case a stored flag would get wrong. Only for an app that
  // wants push deploys through a connection - GitHub carries its own, and a
  // repo with auto-deploy off is not waiting on a webhook.
  const webhook =
    providerTriggers && project.source !== "github" && project.autoDeploy
      ? await appWebhookStatus(project.repo)
      : null;

  // Whether this app accrues rollbacks at all - the same rule the deploy edge
  // uses to decide it mints an image (`deployImageRef`): a repository or an
  // uploaded archive, and not a compose stack.
  const canRollBack =
    !usesComposeStack(project) &&
    (project.source === "github" ||
      project.source === "git" ||
      project.source === "upload");

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
          connections={connections}
          webhook={webhook}
          deployHookEnabled={project.deployHookEnabled}
          composeUpArgs={project.composeUpArgs}
          // The link's shape, never its token: the real URL is fetched only when
          // someone with `configure_apps` deliberately reveals it. An app a git
          // provider already triggers gets no deploy hook in the UI at all - and
          // null here keeps its link out of the page payload entirely, rather
          // than merely hiding it.
          deployHookUrlMasked={
            providerTriggers ? null : await deployHookUrlMasked(project.id)
          }
        />
        {/* Only where a rollback can exist at all: the app has to be one Deplo
            BUILDS. A compose stack has no single image to re-run, and a prebuilt
            `docker-image` source is a registry tag with nothing pinned behind it -
            going "back" to it would land on whatever it points at today. */}
        {canRollBack && (
          <RollbackSettingsForm
            appId={project.id}
            rollbackKeep={project.rollbackKeep}
          />
        )}
      </CapabilityFieldset>
    </section>
  );
}
