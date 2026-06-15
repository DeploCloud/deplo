import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { NewProjectWizard } from "@/components/projects/new-project-wizard";
import { getTemplate } from "@/lib/templates";
import { getTemplateBlueprint } from "@/lib/templates-blueprint";
import { listServers } from "@/lib/data/servers";

export const metadata = { title: "New Project" };

export default async function NewProjectPage(props: PageProps<"/new">) {
  const sp = await props.searchParams;
  const templateId = Array.isArray(sp.template) ? sp.template[0] : sp.template;
  const repoParam = Array.isArray(sp.repo) ? sp.repo[0] : sp.repo;

  const template = templateId ? getTemplate(templateId) : undefined;
  const blueprint = template ? getTemplateBlueprint(template.id) : null;
  const servers = (await listServers()).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
  }));

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
          title={template ? `Deploy ${template.name}` : "Create a new Project"}
          description={
            template
              ? "Choose a server, edit the docker-compose and environment variables, then deploy. Deplo configures Docker + Traefik automatically."
              : "Deploy from Git, a Docker image, a Dockerfile or an upload. Deplo detects your framework and configures Docker + Traefik for you."
          }
        />
      </div>

      <NewProjectWizard
        servers={servers}
        template={
          template
            ? {
                id: template.id,
                name: template.name,
                description: template.description,
                logo: template.logo,
                compose: blueprint?.compose ?? "",
                env: blueprint?.env ?? [],
              }
            : undefined
        }
        presetRepo={repoParam}
        presetName={template?.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
      />
    </div>
  );
}
