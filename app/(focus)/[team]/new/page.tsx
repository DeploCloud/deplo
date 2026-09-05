import Link from "@/components/ui/link";
import { Lock, CloudOff, X } from "lucide-react";

import { hasCapabilityAnywhere, isInstanceAdmin } from "@/lib/membership";
import { DeploLogo } from "@/components/logo";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { NewAppWizard } from "@/components/apps/new-app-wizard";
import { getTemplateBlueprint } from "@/lib/templates-blueprint";
import { listBuildServerChoices, listServerChoices } from "@/lib/data/servers";
import { listGithubInstallations } from "@/lib/data/github";
import { listGitConnections } from "@/lib/data/git-connections";
import { gitProviderChoices } from "@/lib/git/provider-choices";
import { listSharedVars } from "@/lib/data/shared-vars";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { instanceHost, productionDomain } from "@/lib/deploy/domains";
import {
  placementFromSearchParams,
  placementHref,
  templatesHref,
} from "@/lib/overview-links";
import { getTemplateVariant, templateLogoDataUri } from "@/templates/catalog";
import type { DeploySource } from "@/lib/types";

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

/** The wizard's own chrome: the mark, and the one way out. */
function FocusFrame({
  exitHref,
  children,
}: {
  exitHref: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <Link href="/" className="cursor-pointer">
          <DeploLogo />
        </Link>
        <Button variant="ghost" size="icon" asChild aria-label="Close">
          <Link href={exitHref}>
            <X className="size-5" />
          </Link>
        </Button>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-2xl">{children}</div>
      </main>
    </div>
  );
}

export default async function NewAppPage(props: PageProps<"/[team]/new">) {
  const params = await props.searchParams;
  const placement = await resolveOverviewPlacement(
    placementFromSearchParams(params),
  );

  // The Overview hides its "New app" button without this permission, but the URL
  // is still typeable (and a template's Deploy button lands here).
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
  const sourceParam = one(params.source);
  const presetSource = SOURCES.find((s) => s === sourceParam) ?? null;

  // The catalogue is a remote service: an unknown slug, a stale link or a
  // service having a bad day must not take the whole wizard down.
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

  // Generate the template's public hostname (with its random words baked in) up
  // front and thread it into the blueprint env. createApp passes this same
  // string through as the app's `preferred` auto domain, so the value the app
  // sees matches the domain Traefik routes and the one shown in Domains.
  const autoDomain = template
    ? productionDomain(template.slug, instanceHost())
    : null;
  const blueprint = template
    ? getTemplateBlueprint(template, { domain: autoDomain ?? undefined })
    : null;
  // Apps store their logo inline, so the catalog's remote image is fetched once
  // here: the icon then survives the catalog going away.
  const logo = template
    ? await templateLogoDataUri(template.variant.logo)
    : null;

  const [
    servers,
    buildServers,
    installations,
    connections,
    sharedVars,
    instanceAdmin,
  ] = await Promise.all([
    listServerChoices(),
    listBuildServerChoices(),
    listGithubInstallations(),
    listGitConnections(),
    // Team-wide and `manage_env`-gated: someone who may create an app but not
    // manage variables simply gets no Shared tab, never a refused page.
    listSharedVars().catch(() => []),
    isInstanceAdmin(),
  ]);

  return (
    <FocusFrame exitHref={exitHref}>
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
                logo,
                compose: blueprint?.compose ?? "",
                env: blueprint?.env ?? [],
                expose: blueprint?.expose ?? null,
                exposes: blueprint?.exposes ?? [],
                autoDomain,
                mounts: blueprint?.mounts ?? [],
              }
            : undefined
        }
        presetRepo={repoParam}
        presetName={template?.slug}
        presetSource={presetSource}
        placement={placement}
        exitHref={exitHref}
      />
    </FocusFrame>
  );
}
