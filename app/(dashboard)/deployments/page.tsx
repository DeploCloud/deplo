import { Rocket } from "lucide-react";
import { listDeployments } from "@/lib/data/deployments";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploymentsTable } from "@/components/services/deployments-table";

export const metadata = { title: "Deployments" };

export default async function DeploymentsPage() {
  const [deployments, canDeploy, isAdmin] = await Promise.all([
    listDeployments(),
    hasCapability("deploy"),
    isInstanceAdmin(),
  ]);
  const canManage = canDeploy || isAdmin;

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
        <DeploymentsTable
          showService
          canManage={canManage}
          deployments={deployments.map((d) => ({
            id: d.id,
            serviceId: d.serviceId,
            serviceSlug: d.serviceSlug,
            serviceName: d.serviceName,
            commitMessage: d.commitMessage,
            commitSha: d.commitSha,
            commitUrl: d.commitUrl,
            status: d.status,
            environment: d.environment,
            branch: d.branch,
            createdAt: d.createdAt,
            creator: d.creator,
            url: d.url,
          }))}
        />
      )}
    </div>
  );
}
