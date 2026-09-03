import { notFound } from "next/navigation";
import { Loader2 } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { listDeployments } from "@/lib/data/deployments";
import { isInstanceAdmin } from "@/lib/membership";
import { hasAppCapability } from "@/lib/data/node-access";
import { EmptyState } from "@/components/shared/empty-state";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";
import { DeploymentGraphic } from "@/components/apps/deployment-graphic";
import { DeploymentsTable } from "@/components/apps/deployments-table";
import { titleClass } from "@/components/shared/page-header";

export const metadata = { title: "Deployments" };

const IN_PROGRESS = new Set(["building", "queued"]);

export default async function AppDeploymentsPage(
  props: PageProps<"/[team]/apps/[slug]/deployments">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const [deployments, canDeploy, canRollback, isAdmin] = await Promise.all([
    listDeployments({ appId: project.id }),
    hasAppCapability(project.id, "deploy_apps"),
    hasAppCapability(project.id, "rollback_apps"),
    isInstanceAdmin(),
  ]);
  const inProgress = deployments.filter((d) =>
    IN_PROGRESS.has(d.status),
  ).length;
  const canManage = canDeploy || isAdmin;

  // Passed into the table so it sits opposite the bulk-action buttons on one
  // justify-between row; reused above the empty state.
  const header = (
    <div className="space-y-1">
      <h2 className={titleClass.section}>Deployment history</h2>
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

  const gear = (
    <SettingsShortcut
      href={`/apps/${slug}/settings/deployments`}
      label="Deployment settings"
    />
  );

  return (
    <div className="space-y-4">
      {deployments.length === 0 ? (
        <>
          <div className="flex items-center justify-between gap-3">
            {header}
            {gear}
          </div>
          <EmptyState
            graphic={<DeploymentGraphic />}
            title="No deployments yet"
            docs="deploy.trace"
            description="Deploy this app and every build lands here, with its logs."
          />
        </>
      ) : (
        <DeploymentsTable
          header={header}
          actions={gear}
          canManage={canManage}
          canRollbackApps={canRollback || isAdmin}
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
            prNumber: d.prNumber,
            pullRequestUrl: d.pullRequestUrl,
            branch: d.branch,
            createdAt: d.createdAt,
            creator: d.creator,
            creatorUser: d.creatorUser,
            creatorProvider: d.creatorProvider,
            creatorUrl: d.creatorUrl,
            url: d.url,
            canRollback: d.canRollback,
            rollbackOf: d.rollbackOf,
          }))}
        />
      )}
    </div>
  );
}
