import { notFound } from "next/navigation";
import { Loader2, Rocket } from "lucide-react";
import { getServiceBySlug } from "@/lib/data/services";
import { listDeployments } from "@/lib/data/deployments";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploymentsTable } from "@/components/services/deployments-table";

export const metadata = { title: "Deployments" };

const IN_PROGRESS = new Set(["building", "queued"]);

export default async function ServiceDeploymentsPage(
  props: PageProps<"/services/[slug]/deployments">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  const [deployments, canDeploy, isAdmin] = await Promise.all([
    listDeployments({ serviceId: project.id }),
    hasCapability("deploy"),
    isInstanceAdmin(),
  ]);
  const inProgress = deployments.filter((d) => IN_PROGRESS.has(d.status)).length;
  const canManage = canDeploy || isAdmin;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Deployment history
          </h2>
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
      </div>

      {deployments.length === 0 ? (
        <EmptyState icon={Rocket} title="No deployments yet" />
      ) : (
        <DeploymentsTable
          canManage={canManage}
          scopeServiceId={project.id}
          deployments={deployments.map((d) => ({
            id: d.id,
            serviceId: project.id,
            serviceSlug: slug,
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
