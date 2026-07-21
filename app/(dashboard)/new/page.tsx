import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { NewAppWizard } from "@/components/apps/new-app-wizard";
import { getTemplate } from "@/lib/templates";
import { getTemplateBlueprint } from "@/lib/templates-blueprint";
import { listServersForCurrentTeam } from "@/lib/data/servers";
import { listGithubInstallations } from "@/lib/data/github";
import { resolveOverviewPlacement } from "@/lib/data/placement";
import { instanceHost, productionDomain } from "@/lib/deploy/domains";
import {
  placementFromSearchParams,
  placementHref,
  templatesHref,
} from "@/lib/overview-links";

export const metadata = { title: "New App" };

export default async function NewAppPage(props: PageProps<"/new">) {
  const sp = await props.searchParams;
  const templateId = Array.isArray(sp.template) ? sp.template[0] : sp.template;
  const repoParam = Array.isArray(sp.repo) ? sp.repo[0] : sp.repo;

  // The Overview drill-in this wizard was opened from (?folder= / ?project= &
  // ?env=): the app is CREATED THERE rather than at the team top level. Ids are
  // resolved against what this caller can actually see, so a stale or foreign
  // id degrades to "top level" instead of erroring on deploy — and the data
  // layer re-authorizes the destination on create either way.
  const placement = await resolveOverviewPlacement(placementFromSearchParams(sp));

  const template = templateId ? getTemplate(templateId) : undefined;
  const presetName = template?.name
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Generate the template's public hostname (with its random words baked in) up
  // front and thread it into the blueprint env. createApp passes this same
  // string through as the app's `preferred` auto domain, so the value the
  // app sees matches the domain Traefik routes and the one shown in the Domains
  // section — the words generated here are the words that get persisted.
  const autoDomain = template
    ? productionDomain(presetName || template.id, instanceHost())
    : null;
  const blueprint = template
    ? getTemplateBlueprint(template.id, { domain: autoDomain ?? undefined })
    : null;
  const servers = (await listServersForCurrentTeam()).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
  }));
  const installations = await listGithubInstallations();

  return (
    <div className="space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="mb-2 -ml-2 text-muted-foreground"
        >
          <Link
            href={
              template
                ? templatesHref(placement)
                : placementHref(placement)
            }
          >
            <ArrowLeft className="size-4" />
            {template
              ? "Back to templates"
              : placement
                ? `Back to ${placement.label}`
                : "Back to overview"}
          </Link>
        </Button>
        <PageHeader
          title={template ? `Deploy ${template.name}` : "Create a new App"}
          description={
            (template
              ? "Choose a server, edit the docker-compose and environment variables, then deploy. Deplo configures Docker + Traefik automatically."
              : "Deploy from Git, a Docker image, a Dockerfile or an upload. Deplo builds it and configures Docker + Traefik for you.") +
            // Say up front where it lands, so creating from inside a folder is
            // visibly a create-in-folder and not a create-at-top-level.
            (placement ? ` It will be created in ${placement.label}.` : "")
          }
        />
      </div>

      <NewAppWizard
        servers={servers}
        installations={installations}
        template={
          template
            ? {
                id: template.id,
                name: template.name,
                description: template.description,
                logo: template.logo,
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
        presetName={presetName}
        placement={placement}
      />
    </div>
  );
}
