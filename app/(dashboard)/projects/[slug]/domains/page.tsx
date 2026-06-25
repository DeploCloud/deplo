import { notFound } from "next/navigation";
import { Globe } from "lucide-react";
import { getProjectBySlug } from "@/lib/data/projects";
import { listServers } from "@/lib/data/servers";
import { listDomains } from "@/lib/data/domains";
import { resolveServerIp, productionDomain } from "@/lib/deploy/domains";
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
  const [domains, servers] = await Promise.all([
    listDomains(project.id),
    listServers(),
  ]);
  // A zero-config nip.io hostname (`<slug>-<adjective>-<animal>-<hexip>.nip.io`)
  // the user can drop into the Domain field with one click — resolved here so the
  // server-only IP detection never reaches the client bundle. This is a fresh
  // suggestion for ADDING a domain (the project's own auto domain already exists),
  // so freshly-generated words are fine.
  const server = servers.find((s) => s.id === project.serverId);
  const suggestedDomain = productionDomain(project.slug, resolveServerIp(server));

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
          project={{
            id: project.id,
            name: project.name,
            compose: project.compose,
            defaultPort: project.build.port,
          }}
          suggestedDomain={suggestedDomain}
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
                <DomainRow key={d.id} domain={d} compose={project.compose} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
