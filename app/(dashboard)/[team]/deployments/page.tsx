import { listDeployments } from "@/lib/data/deployments/deployment-queries";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploymentGraphic } from "@/components/apps/deployment-graphic";
import { DeploymentsTable } from "@/components/apps/deployments-table/deployments-table";
import { DeploymentsHeader } from "./header";

export const metadata = { title: "Deployments" };

const FIRST_PAGE = 25;

export default async function DeploymentsPage(
  props: PageProps<"/[team]/deployments">,
) {
  // The first page only, until scrolling, a filter or a search asks for the rest (`?all=1`).
  const full = (await props.searchParams).all === "1";
  const [rows, canDeploy, canRollback, isAdmin] = await Promise.all([
    listDeployments(full ? undefined : { limit: FIRST_PAGE + 1 }),
    hasCapability("deploy_apps"),
    hasCapability("rollback_apps"),
    isInstanceAdmin(),
  ]);
  const complete = full || rows.length <= FIRST_PAGE;
  const deployments = complete ? rows : rows.slice(0, FIRST_PAGE);
  const canManage = canDeploy || isAdmin;

  const header = <DeploymentsHeader />;

  return (
    <div className="space-y-6">
      {deployments.length === 0 ? (
        <>
          {header}
          <EmptyState
            graphic={<DeploymentGraphic />}
            title="No deployments yet"
            docs="deploy.trace"
            description="Once you deploy an app, every build will show up here."
          />
        </>
      ) : (
        <DeploymentsTable
          header={header}
          showApp
          showServer
          canManage={canManage}
          canRollbackApps={canRollback || isAdmin}
          complete={complete}
          deployments={deployments.map((d) => ({
            id: d.id,
            appId: d.appId,
            appSlug: d.appSlug,
            serviceName: d.serviceName,
            appLogo: d.appLogo,
            serverId: d.serverId,
            serverName: d.serverName,
            buildServerName: d.buildServerName,
            commitMessage: d.commitMessage,
            commitSha: d.commitSha,
            commitUrl: d.commitUrl,
            commitSignature: d.commitSignature,
            status: d.status,
            prNumber: d.prNumber,
            previewId: d.previewId,
            pullRequestUrl: d.pullRequestUrl,
            branch: d.branch,
            createdAt: d.createdAt,
            creator: d.creator,
            creatorUser: d.creatorUser,
            creatorProvider: d.creatorProvider,
            creatorUrl: d.creatorUrl,
            url: d.url,
            canRollback: d.canRollback,
            rollbackRebuilds: d.rollbackRebuilds,
            rollbackOf: d.rollbackOf,
            appMigrating: d.appMigrating,
          }))}
        />
      )}
    </div>
  );
}
