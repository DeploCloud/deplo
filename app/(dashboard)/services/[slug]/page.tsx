import Link from "next/link";
import { notFound } from "next/navigation";
import {
  GitBranch,
  Clock,
  ScrollText,
  ExternalLink,
  Rocket,
} from "lucide-react";
import { getServiceBySlug } from "@/lib/data/services";
import { listDeployments } from "@/lib/data/deployments";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge, StatusDot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { describeServiceSource } from "@/components/services/service-source";
import { CommitLink } from "@/components/services/commit-link";
import { githubCommitUrl, timeAgo } from "@/lib/utils";

export default async function ServiceOverview(
  props: PageProps<"/services/[slug]">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  const deployments = await listDeployments({ serviceId: project.id });
  const prod = project.latestDeployment;
  // What backs this service — a git repo (real branch/commit) or a compose
  // stack / docker image / upload (no git, so no branch). Same source of truth
  // as the Overview card, so the page never invents a "main" branch for a
  // compose project. See components/services/service-source.tsx.
  const src = describeServiceSource(project);

  return (
    <div className="space-y-6">
      {/* Production hero */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Production Deployment</CardTitle>
          <Badge variant="secondary">Production</Badge>
        </CardHeader>
        <CardContent>
          {prod ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-muted-foreground">Domain</p>
                  {project.productionUrl && (
                    <a
                      href={project.productionUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cursor-pointer text-sm font-medium hover:underline"
                    >
                      {project.productionUrl.replace(/^https?:\/\//, "")}
                    </a>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <div className="mt-1">
                    <StatusBadge status={prod.status} />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Created</p>
                  <p className="text-sm">
                    {timeAgo(prod.createdAt)} by {prod.creator}
                  </p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-muted-foreground">Source</p>
                  {src.isGit ? (
                    // Git deploy: a real branch + commit are meaningful.
                    <>
                      <p className="flex items-center gap-1.5 text-sm">
                        <GitBranch className="size-3.5 shrink-0" />
                        {prod.branch}
                        <CommitLink
                          sha={prod.commitSha}
                          url={githubCommitUrl(project.repo, prod.commitSha)}
                          className="ml-1 font-mono text-xs text-muted-foreground"
                        />
                      </p>
                      <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                        {prod.commitMessage}
                      </p>
                    </>
                  ) : (
                    // No git (compose / image / upload): show what the service
                    // actually IS instead of a fabricated branch.
                    <p className="flex items-center gap-1.5 text-sm">
                      <src.Icon className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate">{src.label}</span>
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Build time</p>
                  <p className="flex items-center gap-1.5 text-sm">
                    <Clock className="size-3.5" />
                    {formatDuration(prod.buildDurationMs)}
                  </p>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/services/${slug}/deployments/${prod.id}`}>
                      <ScrollText className="size-4" />
                      Build Logs
                    </Link>
                  </Button>
                  {project.productionUrl && (
                    <Button size="sm" variant="outline" asChild>
                      <a
                        href={project.productionUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="size-4" />
                        Visit
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No production deployment yet.
              </p>
              {/* Even before the first deploy, show where this service comes
                  from (its git repo, a compose stack, an image or an upload). */}
              <div>
                <p className="text-xs text-muted-foreground">Source</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm">
                  <src.Icon className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{src.label}</span>
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Deployments */}
      <div id="deployments" className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Deployments</h2>
        {deployments.length === 0 ? (
          <EmptyState icon={Rocket} title="No deployments yet" />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            {deployments.map((d) => (
              <Link
                key={d.id}
                href={`/services/${slug}/deployments/${d.id}`}
                className="flex cursor-pointer items-center gap-4 border-b border-border px-4 py-3 last:border-0 hover:bg-accent/40"
              >
                <StatusDot status={d.status} />
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
                    {d.branch}
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
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {formatDuration(d.buildDurationMs)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {timeAgo(d.createdAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number | null): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
