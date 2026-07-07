import Link from "next/link";
import { Rocket, GitBranch } from "lucide-react";
import { listDeployments } from "@/lib/data/deployments";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { CommitLink } from "@/components/services/commit-link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { timeAgo } from "@/lib/utils";
import { DeploymentActions } from "./deployment-actions";

export const metadata = { title: "Deployments" };

export default async function DeploymentsPage() {
  const deployments = await listDeployments();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deployments"
        description="Every deployment across all of your services, newest first."
      />

      {deployments.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title="No deployments yet"
          description="Once you deploy a service, every build will show up here."
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Deployment</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="max-w-[280px]">
                    <p className="truncate font-medium text-foreground">
                      {d.commitMessage}
                    </p>
                    <CommitLink
                      sha={d.commitSha}
                      url={d.commitUrl}
                      className="font-mono text-xs text-muted-foreground"
                    />
                  </TableCell>

                  <TableCell>
                    <Link
                      href={`/services/${d.serviceSlug}`}
                      className="cursor-pointer font-medium text-foreground hover:underline"
                    >
                      {d.serviceName}
                    </Link>
                  </TableCell>

                  <TableCell>
                    <StatusBadge status={d.status} />
                  </TableCell>

                  <TableCell>
                    <Badge
                      variant={
                        d.environment === "production" ? "default" : "secondary"
                      }
                      className="capitalize"
                    >
                      {d.environment}
                    </Badge>
                  </TableCell>

                  <TableCell>
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <GitBranch className="size-3.5 shrink-0" />
                      <span className="truncate font-mono text-xs">
                        {d.branch}
                      </span>
                    </span>
                  </TableCell>

                  <TableCell>
                    <p className="whitespace-nowrap text-foreground">
                      {timeAgo(d.createdAt)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      by {d.creator}
                    </p>
                  </TableCell>

                  <TableCell className="text-right">
                    <DeploymentActions
                      id={d.id}
                      serviceId={d.serviceId}
                      url={d.url}
                      status={d.status}
                      environment={d.environment}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
