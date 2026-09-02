import { notFound } from "next/navigation";
import { Rocket } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { listServerChoices } from "@/lib/data/servers";
import { installationAccess, listGithubInstallations } from "@/lib/data/github";
import {
  appWebhookStatus,
  listGitConnections,
} from "@/lib/data/git-connections";
import { providerFor } from "@/lib/git/providers";
import { gitProviderChoices } from "@/lib/git/provider-choices";
import { requiredAccess } from "@/lib/git/provider-access";
import { repoCloneRefusal } from "@/lib/git/repo-access";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DeploymentSettingsForm } from "@/components/apps/settings/deployment-settings-form";
import { RollbackSettingsForm } from "@/components/apps/settings/rollback-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import { appBuildsItsOwnImage } from "@/lib/utils";
import type { GitProviderId } from "@/lib/types";

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

  // Does a git provider ALREADY trigger this app's deploys?
  const providerTriggers =
    project.source === "github" ||
    (Boolean(project.repo?.connectionId) &&
      providerFor(project.repo?.provider ?? "git").api != null);

  // Whether the push webhook is actually registered on the provider right now, asked
  // of the provider rather than remembered: someone deleting it on their side is
  // exactly the case a stored flag would get wrong.
  const webhook =
    providerTriggers && project.source !== "github" && project.autoDeploy
      ? await appWebhookStatus(project.repo)
      : null;

  // What the host has not allowed, before a deploy discovers it in a build log.
  // Both halves are live reads that fail open: an unreachable provider says
  // nothing rather than accusing one.
  const [repoAccess, cloneRefusal, canManageGit] = await Promise.all([
    project.repo?.installationId
      ? installationAccess(project.repo.installationId, {
          previews: project.previewEnabled,
        })
      : null,
    project.repo ? repoCloneRefusal(project.repo) : null,
    hasCapability("manage_git"),
  ]);

  // Whether this app accrues rollbacks at all - the SAME predicate the data layer
  // gates on, so the card cannot offer a setting the action would refuse.
  const canRollBack = appBuildsItsOwnImage(project);

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Rocket}
        title="Deployment"
        docs="releases.autoDeploy"
      />
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
          providers={gitProviderChoices()}
          isInstanceAdmin={await isInstanceAdmin()}
          webhook={webhook}
          repoAccess={repoAccess}
          cloneRefusal={cloneRefusal}
          canManageGit={canManageGit}
          connectionAccess={
            project.repo?.connectionId
              ? requiredAccess(project.repo.provider as GitProviderId)
              : []
          }
        />
        {/**
         * Only where a rollback can exist at all: the app has to be one Deplo BUILDS.
         */}
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
