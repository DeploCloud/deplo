import { Rocket } from "lucide-react";
import { listDeployments } from "@/lib/data/deployments";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
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

  // Passed into the table so it can sit opposite the bulk-action buttons on one
  // justify-between row; reused above the empty state.
  const header = (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
      <p className="text-sm text-muted-foreground">
        Every deployment across all of your services and servers, newest first.
      </p>
    </div>
  );

  return (
    <div className="space-y-6">
      {deployments.length === 0 ? (
        <>
          {header}
          <EmptyState
            icon={Rocket}
            title="No deployments yet"
            description="Once you deploy a service, every build will show up here."
          />
        </>
      ) : (
        <DeploymentsTable
          header={header}
          showService
          showServer
          canManage={canManage}
          deployments={deployments.map((d) => ({
            id: d.id,
            serviceId: d.serviceId,
            serviceSlug: d.serviceSlug,
            serviceName: d.serviceName,
            serverId: d.serverId,
            serverName: d.serverName,
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
