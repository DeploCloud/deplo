import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { NewServiceWizard } from "@/components/services/new-service-wizard";
import { getTemplate } from "@/lib/templates";
import { getTemplateBlueprint } from "@/lib/templates-blueprint";
import { listServersForCurrentTeam } from "@/lib/data/servers";
import { listGithubInstallations } from "@/lib/data/github";
import { instanceHost, productionDomain } from "@/lib/deploy/domains";

export const metadata = { title: "New Service" };

export default async function NewServicePage(props: PageProps<"/new">) {
  const sp = await props.searchParams;
  const templateId = Array.isArray(sp.template) ? sp.template[0] : sp.template;
  const repoParam = Array.isArray(sp.repo) ? sp.repo[0] : sp.repo;

  const template = templateId ? getTemplate(templateId) : undefined;
  const presetName = template?.name
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Generate the template's public hostname (with its random words baked in) up
  // front and thread it into the blueprint env. createService passes this same
  // string through as the service's `preferred` auto domain, so the value the
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
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="mb-2 -ml-2 text-muted-foreground"
        >
          <Link href={template ? "/templates" : "/"}>
            <ArrowLeft className="size-4" />
            {template ? "Back to templates" : "Back to overview"}
          </Link>
        </Button>
        <PageHeader
          title={template ? `Deploy ${template.name}` : "Create a new Service"}
          description={
            template
              ? "Choose a server, edit the docker-compose and environment variables, then deploy. Deplo configures Docker + Traefik automatically."
              : "Deploy from Git, a Docker image, a Dockerfile or an upload. Deplo detects your framework and configures Docker + Traefik for you."
          }
        />
      </div>

      <NewServiceWizard
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
      />
    </div>
  );
}
