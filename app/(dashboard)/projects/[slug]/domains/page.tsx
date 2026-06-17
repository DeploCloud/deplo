import { notFound } from "next/navigation";
import { Globe } from "lucide-react";
import { getProjectBySlug } from "@/lib/data/projects";
import { listDomains } from "@/lib/data/domains";
import { usesComposeStack } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AddDomain } from "@/components/domains/add-domain";
import { DomainRow } from "@/components/domains/domain-row";

export const metadata = { title: "Project Domains" };

export default async function ProjectDomainsPage(
  props: PageProps<"/projects/[slug]/domains">
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const domains = await listDomains(project.id);
  // Per-domain port overrides apply only to single-image / built projects; a
  // compose stack routes per-service via its compose file.
  const portConfigurable = !usesComposeStack(project);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Domains</h3>
          <p className="text-sm text-muted-foreground">
            Custom domains routed to this project with automatic TLS.
          </p>
        </div>
        <AddDomain
          projects={[{ id: project.id, name: project.name }]}
          defaultProjectId={project.id}
          composeProjectIds={portConfigurable ? [] : [project.id]}
        />
      </div>

      {domains.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No domains"
          description="Add a custom domain to this project."
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.map((d) => (
                <DomainRow
                  key={d.id}
                  domain={d}
                  portConfigurable={portConfigurable}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
