import { Globe } from "lucide-react";
import { listDomains } from "@/lib/data/domains";
import { listProjects } from "@/lib/data/projects";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DomainRow } from "@/components/domains/domain-row";

export const metadata = { title: "Domains" };

export default async function DomainsPage() {
  const [domains, projects] = await Promise.all([listDomains(), listProjects()]);
  // Carry each project's compose YAML so the Edit dialog can offer a service
  // selector. Domains are ADDED from each project's own Domains tab (this is a
  // read-only cross-project overview — there is no single project to attach to).
  const composeById = new Map(projects.map((p) => [p.id, p.compose]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Domains"
        description="Custom domains and automatic TLS certificates across your projects."
      />

      {domains.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No domains yet"
          description="Add a custom domain from a project's Domains tab. Deplo issues SSL automatically."
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
                  compose={composeById.get(d.projectId)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
