import Link from "@/components/ui/link";
import { Lock, CloudOff } from "lucide-react";

import {
  hasCapabilityAnywhere,
  isInstanceAdmin,
  requireActiveTeamId,
} from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { NewAppWizard } from "@/components/apps/new-app-wizard/new-app-wizard";
import { FocusFrame } from "@/components/apps/new-app-wizard/focus-frame";
import { getTemplateBlueprint } from "@/lib/templates-blueprint";
import {
  listBuildServerChoices,
  listServerChoices,
} from "@/lib/data/servers/roster";
import { listGithubInstallations } from "@/lib/data/github";
import { listGitConnections } from "@/lib/data/git-connections";
import { listNewRepos } from "@/lib/data/new-repos";
import { WizardCard } from "@/components/apps/wizard/wizard-card";
import { NewRepoList } from "@/components/apps/new-repo-list";
import { gitProviderChoices } from "@/lib/git/provider-choices";
import { listSharedVars } from "@/lib/data/shared-vars/team-view";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { instanceHost, productionDomain } from "@/lib/deploy/domains";
import {
  placementFromSearchParams,
  placementHref,
  templatesHref,
} from "@/lib/overview-links";
import {
  getTemplateVariant,
  templateAssetUrl,
  templateLogoDataUri,
} from "@/templates/catalog";
import { templateAccent } from "@/lib/templates/logo-color";
import { loadComposeFromUrl } from "@/lib/templates/from-url";
import {
  cloneHostLabel,
  parseCloneSource,
  suggestedRepoName,
} from "@/lib/git/clone-source";
import { listCloneDestinations } from "@/lib/data/clone-repository";
import type { WizardClone } from "@/components/apps/new-app-wizard/types";
import { docsUrl } from "@/lib/docs";
import type { DeploySource } from "@/lib/types/app";

export const metadata = { title: "New App" };

const SOURCES: DeploySource[] = [
  "github",
  "git",
  "docker-image",
  "upload",
  "compose",
];

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function NewAppPage(props: PageProps<"/[team]/new">) {
  const params = await props.searchParams;
  const placement = await resolveOverviewPlacement(
    placementFromSearchParams(params),
  );

  if (!(await hasCapabilityAnywhere("create_apps")))
    return (
      <FocusFrame exitHref={placementHref(placement)}>
        <EmptyState
          icon={Lock}
          title="You can't create apps"
          docs="roles.floorCeiling"
          description="Ask a team admin for permission to create apps, or pick an app you already have from the overview."
          action={
            <Button asChild size="sm">
              <Link href="/">Back to overview</Link>
            </Button>
          }
        />
      </FocusFrame>
    );

  const templateId = one(params.template);
  const variantId = one(params.variant);
  const repoParam = one(params.repo);
  const branchParam = one(params.branch);
  const installationParam = one(params.installation);
  const connectionParam = one(params.connection);
  const sourceParam = one(params.source);
  const composeParam = one(params.compose);
  const cloneParam = one(params.clone);
  const presetSource = SOURCES.find((s) => s === sourceParam) ?? null;
  const detected = one(params.detected) === "1";

  if (detected && !repoParam) {
    const [repos, teamId] = await Promise.all([
      listNewRepos().catch(() => []),
      requireActiveTeamId(),
    ]);
    return (
      <FocusFrame exitHref={placementHref(placement)}>
        <WizardCard
          title="Import a new repository"
          description="Pick one to set it up. Deplo builds it and puts it online."
        >
          <NewRepoList repos={repos} teamId={teamId} />
        </WizardCard>
      </FocusFrame>
    );
  }

  const template =
    templateId && variantId
      ? await getTemplateVariant(templateId, variantId).catch(() => null)
      : null;
  const exitHref = template
    ? templatesHref(placement)
    : placementHref(placement);
  if ((templateId || variantId) && !template)
    return (
      <FocusFrame exitHref={exitHref}>
        <EmptyState
          icon={CloudOff}
          title="That template isn't available"
          description="Deplo could not load this template from the catalog. Pick another one, or create the app from Git or a Docker image."
          action={
            <Button asChild size="sm">
              <Link href={templatesHref(placement)}>Back to templates</Link>
            </Button>
          }
        />
      </FocusFrame>
    );

  // A Deploy button: the project is copied into the team's Git account and built from there.
  const cloneSource =
    !template && (cloneParam || composeParam)
      ? parseCloneSource({ repo: cloneParam, compose: composeParam })
      : null;
  if (cloneParam && !cloneSource)
    return (
      <FocusFrame exitHref={exitHref}>
        <EmptyState
          icon={CloudOff}
          title="That repository isn't available"
          description="This Deploy button has to link to a public GitHub or GitLab repository."
          docs="deploy.button"
          action={
            <Button asChild size="sm">
              <Link href="/new">Create from scratch</Link>
            </Button>
          }
        />
      </FocusFrame>
    );

  const imported =
    !template && !cloneSource && composeParam
      ? await loadComposeFromUrl(composeParam)
      : null;
  if (imported && !imported.ok)
    return (
      <FocusFrame exitHref={exitHref}>
        <EmptyState
          icon={CloudOff}
          title="That compose file isn't available"
          description={imported.error}
          docs="deploy.button"
          action={
            <div className="flex gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={exitHref}>Back to overview</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/new">Create from scratch</Link>
              </Button>
            </div>
          }
        />
      </FocusFrame>
    );

  const spec =
    template ??
    (imported
      ? {
          slug: imported.name,
          compose: imported.compose,
          config: imported.config,
        }
      : null);
  const autoDomain = spec ? productionDomain(spec.slug, instanceHost()) : null;
  const blueprint = spec
    ? getTemplateBlueprint(spec, { domain: autoDomain ?? undefined })
    : null;
  const logo = template
    ? await templateLogoDataUri(template.variant.logo)
    : (imported?.logo ?? null);
  const veil = template
    ? await templateAccent(
        template.slug,
        template.variant.logo ? templateAssetUrl(template.variant.logo) : null,
      )
    : undefined;

  const [
    servers,
    buildServers,
    installations,
    connections,
    sharedVars,
    instanceAdmin,
    cloneTargets,
  ] = await Promise.all([
    listServerChoices(),
    listBuildServerChoices(),
    listGithubInstallations(),
    listGitConnections(),
    listSharedVars().catch(() => []),
    isInstanceAdmin(),
    cloneSource
      ? listCloneDestinations().catch(() => ({
          destinations: [],
          unreachable: [],
        }))
      : null,
  ]);
  const signIn = one(params.github);
  const clone: WizardClone | undefined =
    cloneSource && cloneTargets
      ? {
          host: cloneSource.host,
          hostLabel: cloneHostLabel(cloneSource.host),
          fullName: cloneSource.fullName,
          ref: cloneSource.ref,
          composeFile: cloneSource.composeFile,
          repoParam: cloneParam ?? null,
          composeParam: composeParam ?? null,
          suggestedName: suggestedRepoName(cloneSource),
          destinations: cloneTargets.destinations,
          unreachable: cloneTargets.unreachable,
          signIn: signIn === "denied" || signIn === "error" ? signIn : null,
        }
      : undefined;

  return (
    <FocusFrame exitHref={exitHref} narrow={Boolean(spec || clone)}>
      <NewAppWizard
        servers={servers}
        buildServers={buildServers}
        sharedVars={sharedVars.map((v) => ({
          id: v.id,
          key: v.key,
          type: v.type,
          teamWide: v.teamWide,
        }))}
        installations={installations}
        connections={connections}
        providers={gitProviderChoices()}
        isInstanceAdmin={instanceAdmin}
        template={
          template
            ? {
                id: template.slug,
                name: template.name,
                variantName:
                  template.variants.length > 1
                    ? template.variant.name
                    : undefined,
                description: template.variant.shortDescription,
                alerts: template.variant.alerts,
                logo,
                veil,
                compose: blueprint?.compose ?? "",
                env: blueprint?.env ?? [],
                expose: blueprint?.expose ?? null,
                exposes: blueprint?.exposes ?? [],
                autoDomain,
                mounts: blueprint?.mounts ?? [],
              }
            : imported && blueprint
              ? {
                  id: imported.name,
                  name: imported.name,
                  description: `From ${imported.origin}`,
                  alerts: [
                    {
                      type: "warning",
                      message:
                        "Not from the Deplo catalog. Review it before you deploy.",
                      link: docsUrl("deploy.button"),
                    },
                  ],
                  logo,
                  compose: blueprint.compose,
                  env: blueprint.env,
                  expose: blueprint.expose,
                  exposes: blueprint.exposes,
                  autoDomain: blueprint.expose ? autoDomain : null,
                  mounts: blueprint.mounts,
                  imported: true,
                }
              : undefined
        }
        clone={clone}
        presetRepo={repoParam}
        presetBranch={branchParam}
        presetInstallationId={installationParam}
        presetConnectionId={connectionParam}
        presetName={template?.slug ?? imported?.name}
        presetSource={presetSource}
        placement={placement}
        exitHref={exitHref}
        backHref={detected && repoParam ? "/new?detected=1" : undefined}
      />
    </FocusFrame>
  );
}
