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
import { AddDomain } from "@/components/domains/add-domain";
import { DomainRow } from "@/components/domains/domain-row";

export const metadata = { title: "Domains" };

export default async function DomainsPage() {
  const [domains, projects] = await Promise.all([listDomains(), listProjects()]);
  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Domains"
        description="Custom domains and automatic TLS certificates across your projects."
        actions={<AddDomain projects={projectOptions} />}
      />

      {domains.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No domains yet"
          description="Add a custom domain to one of your projects. Deplo issues SSL automatically."
          action={<AddDomain projects={projectOptions} />}
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
                <DomainRow key={d.id} domain={d} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
