import { notFound } from "next/navigation";
import { Loader2, Rocket } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { listDeployments } from "@/lib/data/deployments";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploymentsTable } from "@/components/apps/deployments-table";

export const metadata = { title: "Deployments" };

const IN_PROGRESS = new Set(["building", "queued"]);

export default async function AppDeploymentsPage(
  props: PageProps<"/apps/[slug]/deployments">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const [deployments, canDeploy, isAdmin] = await Promise.all([
    listDeployments({ appId: project.id }),
    hasCapability("deploy"),
    isInstanceAdmin(),
  ]);
  const inProgress = deployments.filter((d) => IN_PROGRESS.has(d.status)).length;
  const canManage = canDeploy || isAdmin;

  // Passed into the table so it sits opposite the bulk-action buttons on one
  // justify-between row; reused above the empty state.
  const header = (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold tracking-tight">Deployment history</h2>
      <p className="text-sm text-muted-foreground">
        {deployments.length} total
        {inProgress > 0 && (
          <>
            {" · "}
            <span className="inline-flex items-center gap-1 text-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {inProgress} in progress
            </span>
          </>
        )}
      </p>
    </div>
  );

  return (
    <div className="space-y-4">
      {deployments.length === 0 ? (
        <>
          {header}
          <EmptyState icon={Rocket} title="No deployments yet" />
        </>
      ) : (
        <DeploymentsTable
          header={header}
          canManage={canManage}
          scopeAppId={project.id}
          deployments={deployments.map((d) => ({
            id: d.id,
            appId: project.id,
            appSlug: slug,
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
