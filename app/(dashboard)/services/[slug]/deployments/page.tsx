import Link from "next/link";
import { notFound } from "next/navigation";
import { GitBranch, Loader2, Rocket } from "lucide-react";
import { getServiceBySlug } from "@/lib/data/services";
import { listDeployments } from "@/lib/data/deployments";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { CommitLink } from "@/components/services/commit-link";
import { DeploymentActions } from "@/components/services/deployment-actions";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/utils";

export const metadata = { title: "Deployments" };

const IN_PROGRESS = new Set(["building", "queued"]);

export default async function ServiceDeploymentsPage(
  props: PageProps<"/services/[slug]/deployments">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  const deployments = await listDeployments({ serviceId: project.id });
  const inProgress = deployments.filter((d) => IN_PROGRESS.has(d.status)).length;

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
        <div className="overflow-hidden rounded-xl border border-border">
          {deployments.map((d) => {
            const building = IN_PROGRESS.has(d.status);
            return (
              <div
                key={d.id}
                className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0 hover:bg-accent/40"
              >
                {/* Whole-row click opens the deployment; the actions cluster is a
                    sibling of this Link (never nested inside it) so the ⋯ menu
                    and its own links stay valid, clickable interactive elements. */}
                <Link
                  href={`/services/${slug}/deployments/${d.id}`}
                  className="flex min-w-0 flex-1 items-center gap-4"
                >
                  <div className="w-24 shrink-0">
                    <StatusBadge status={d.status} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-sm font-medium">
                      {d.commitMessage}
                    </p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CommitLink
                        sha={d.commitSha}
                        url={d.commitUrl}
                        className="font-mono"
                      />
                      <GitBranch className="size-3" />
                      <span className="max-w-40 truncate">{d.branch}</span>
                    </p>
                  </div>
                  <Badge
                    variant={
                      d.environment === "production" ? "default" : "secondary"
                    }
                    className="hidden sm:inline-flex"
                  >
                    {d.environment}
                  </Badge>
                  <span className="hidden w-20 text-right text-xs text-muted-foreground sm:inline">
                    {building ? "—" : formatDuration(d.buildDurationMs)}
                  </span>
                  <span className="w-24 text-right text-xs text-muted-foreground">
                    {timeAgo(d.createdAt)}
                  </span>
                </Link>
                <DeploymentActions
                  id={d.id}
                  serviceId={project.id}
                  serviceSlug={slug}
                  url={d.url}
                  status={d.status}
                  environment={d.environment}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number | null): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
