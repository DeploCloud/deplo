import { notFound } from "next/navigation";
import { Rocket } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { listServerChoices } from "@/lib/data/servers/roster";
import { neighboursOnNetwork } from "@/lib/data/name-clash";
import { installationAccess, listGithubInstallations } from "@/lib/data/github";
import {
  appWebhookStatus,
  listGitConnections,
} from "@/lib/data/git-connections";
import { providerFor } from "@/lib/git/providers/registry";
import { gitProviderChoices } from "@/lib/git/provider-choices";
import { requiredAccess } from "@/lib/git/provider-access";
import { repoCloneRefusal } from "@/lib/git/repo-access";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { hasAppCapability } from "@/lib/data/node-access";
import { redactComposeForDisplay } from "@/lib/deploy/compose-redact";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DeploymentSettingsForm } from "@/components/apps/settings/deployment-settings-form/deployment-settings-form";
import { RollbackSettingsForm } from "@/components/apps/settings/rollback-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import { appBuildsItsOwnImage } from "@/lib/utils";
import type { GitProviderId } from "@/lib/types/git";

export const metadata = { title: "Deployment" };

export default async function AppDeploymentSettingsPage(
  props: PageProps<"/[team]/apps/[slug]/settings/deployments">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const servers = await listServerChoices();
  // Who this app talks to by name on its server: a move cuts it off from them.
  const neighbours = await neighboursOnNetwork(
    {
      teamId: project.teamId,
      environmentId: project.environmentId ?? null,
      serverId: project.serverId,
    },
    project.id,
  );
  const installations = await listGithubInstallations();
  const connections = await listGitConnections();

  const providerTriggers =
    project.source === "github" ||
    (Boolean(project.repo?.connectionId) &&
      providerFor(project.repo?.provider ?? "git").api != null);

  // Asked of the provider, not remembered: a stored flag misses a webhook deleted on their side.
  const webhook =
    providerTriggers && project.source !== "github" && project.autoDeploy
      ? await appWebhookStatus(project.repo)
      : null;

  // Both halves fail open: an unreachable provider says nothing rather than accusing one.
  const [repoAccess, cloneRefusal, canManageGit] = await Promise.all([
    project.repo?.installationId
      ? installationAccess(project.repo.installationId, {
          previews: project.previewEnabled,
        })
      : null,
    project.repo ? repoCloneRefusal(project.repo) : null,
    hasCapability("manage_git"),
  ]);

  // The same predicate the data layer gates on, so the card cannot offer a refused setting.
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
          compose={
            (await hasAppCapability(project.id, "configure_apps"))
              ? project.compose
              : project.compose == null
                ? null
                : redactComposeForDisplay(project.compose)
          }
          serverId={project.serverId}
          servers={servers}
          neighbours={neighbours}
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
        {/* Only where a rollback can exist: the app has to be one Deplo builds. */}
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
