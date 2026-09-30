import Link from "@/components/ui/link";
import { cn } from "@/lib/utils";
import { Lock, CloudOff, X } from "lucide-react";

import { hasCapabilityAnywhere, isInstanceAdmin } from "@/lib/membership";
import { DeploLogo } from "@/components/logo";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { NewAppWizard } from "@/components/apps/new-app-wizard/new-app-wizard";
import { getTemplateBlueprint } from "@/lib/templates-blueprint";
import {
  listBuildServerChoices,
  listServerChoices,
} from "@/lib/data/servers/roster";
import { listGithubInstallations } from "@/lib/data/github";
import { listGitConnections } from "@/lib/data/git-connections";
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

function FocusFrame({
  exitHref,
  narrow,
  children,
}: {
  exitHref: string;
  narrow?: boolean;
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
        <div className={cn("w-full", narrow ? "max-w-lg" : "max-w-2xl")}>
          {children}
        </div>
      </main>
    </div>
  );
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
  const sourceParam = one(params.source);
  const composeParam = one(params.compose);
  const presetSource = SOURCES.find((s) => s === sourceParam) ?? null;

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

  const imported =
    !template && composeParam ? await loadComposeFromUrl(composeParam) : null;
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
  ] = await Promise.all([
    listServerChoices(),
    listBuildServerChoices(),
    listGithubInstallations(),
    listGitConnections(),
    listSharedVars().catch(() => []),
    isInstanceAdmin(),
  ]);

  return (
    <FocusFrame exitHref={exitHref} narrow={Boolean(spec)}>
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
        presetRepo={repoParam}
        presetName={template?.slug ?? imported?.name}
        presetSource={presetSource}
        placement={placement}
        exitHref={exitHref}
      />
    </FocusFrame>
  );
}
