import Link from "@/components/ui/link";
import { notFound } from "next/navigation";
import {
  GitBranch,
  GitPullRequest,
  Clock,
  ScrollText,
  ExternalLink,
  ArrowRight,
} from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { hasAppCapability } from "@/lib/data/node-access";
import { DataCopyNotice } from "@/components/shared/data-copy-notice";
import { DeploymentCreator } from "@/components/apps/deployment-creator";
import { listDeployments } from "@/lib/data/deployments";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge, StatusDot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploymentGraphic } from "@/components/apps/deployment-graphic";
import { describeAppSource } from "@/components/apps/app-source";
import { RepoLinkNotice } from "@/components/apps/repo-link-notice";
import { FrameworkBadge } from "@/components/apps/framework-badge";
import {
  effectiveFramework,
  supportsFrameworkDetection,
} from "@/lib/apps/framework-catalog";
import { CommitLink } from "@/components/apps/commit-link";
import {
  formatBuildDuration,
  gitProfileUrl,
  repoCommitUrl,
  repoCredentialMissing,
  timeAgoShort,
} from "@/lib/utils";
import { titleClass } from "@/components/shared/page-header";

export default async function AppOverview(
  props: PageProps<"/[team]/apps/[slug]">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const deployments = await listDeployments({ appId: project.id });
  // Only for the banner's "Deploy anyway": the mutation gates itself, this
  // decides whether the affordance is worth showing.
  const canDeploy = await hasAppCapability(project.id, "deploy_apps");
  // Prefer the row out of `deployments` (loaded two lines up) over the app graph's
  // copy of it: only the list resolves `creatorUser`, and the graph's copy would show
  // "by <name>" with no face beside it.
  const prod =
    deployments.find((d) => d.id === project.latestDeployment?.id) ??
    project.latestDeployment;
  // What backs this app - a git repo (real branch/commit) or a compose stack / docker
  // image / upload (no git, so no branch). Same source of truth as the Overview card,
  // so the page never invents a "main" branch for a compose project.
  const src = describeAppSource(project);

  return (
    <div className="space-y-6">
      {/* The data a migration could not bring. FIRST, above everything: while it
          is set Deploy is refused, so this is the explanation for a button that
          does not work rather than a note beside one that does. */}
      <DataCopyNotice
        kind="app"
        id={project.id}
        name={project.name}
        error={project.dataCopyError}
        canAccept={canDeploy}
        move={Boolean(project.migrateFromServerId)}
      />

      {/* An app that names a repository but has no credential to clone it with:
          the deploy would fail with nothing but `exit status 128` in the log,
          so say it here instead. Derived from the row - no query, no API call. */}
      {repoCredentialMissing(project) && project.repo && (
        <RepoLinkNotice
          slug={slug}
          repoName={project.repo.repo || project.repo.url}
        />
      )}

      {/* Production hero */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Production Deployment</CardTitle>
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
                  <p className="flex items-center gap-1.5 text-sm">
                    {timeAgoShort(prod.createdAt)} by
                    <DeploymentCreator
                      creator={prod.creator}
                      creatorUser={prod.creatorUser}
                      creatorProvider={prod.creatorProvider}
                      creatorUrl={gitProfileUrl(
                        prod.creatorProvider,
                        prod.creator,
                        project.repo?.url,
                      )}
                    />
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
                          url={repoCommitUrl(project.repo, prod.commitSha)}
                          className="ml-1 font-mono text-xs text-muted-foreground"
                        />
                      </p>
                      <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                        {prod.commitMessage}
                      </p>
                    </>
                  ) : (
                    // No git (compose / image / upload): show what the app
                    // actually IS instead of a fabricated branch.
                    <p className="flex items-center gap-1.5 text-sm">
                      <src.Icon className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate">{src.label}</span>
                    </p>
                  )}
                </div>
                {/**
                 * What Deplo recognised in the app's own source (or what the user corrected it to -
                 * effectiveFramework settles that).
                 */}
                {effectiveFramework(project) &&
                  supportsFrameworkDetection(project.build.buildMethod) && (
                    <div>
                      <p className="text-xs text-muted-foreground">Framework</p>
                      <p className="mt-0.5 text-sm">
                        <FrameworkBadge id={effectiveFramework(project)} />
                      </p>
                    </div>
                  )}
                <div>
                  <p className="text-xs text-muted-foreground">Build time</p>
                  <p className="flex items-center gap-1.5 text-sm">
                    <Clock className="size-3.5" />
                    {formatBuildDuration(prod.buildDurationMs)}
                  </p>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/apps/${slug}/deployments/${prod.id}`}>
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
              {/* Even before the first deploy, show where this app comes
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
        <div className="flex flex-row items-center justify-between">
          <h2 className={titleClass.section}>Deployments</h2>
          {deployments.length > 4 && (
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="-mr-2 text-muted-foreground hover:text-foreground"
            >
              <Link href={`/apps/${slug}/deployments`}>
                See all
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          )}
        </div>
        {deployments.length === 0 ? (
          <EmptyState
            graphic={<DeploymentGraphic />}
            title="No deployments yet"
            docs="deploy.trace"
            description="Deploy this app and every build lands here, with its logs."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            {deployments.slice(0, 4).map((d) => (
              <Link
                key={d.id}
                href={`/apps/${slug}/deployments/${d.id}`}
                className="flex cursor-pointer items-center gap-4 border-b border-border px-4 py-3 last:border-0 hover:bg-accent/40"
              >
                <StatusDot status={d.status} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm font-medium">
                    {d.commitMessage}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CommitLink
                      sha={d.commitSha}
                      url={d.commitUrl}
                      className="font-mono"
                    />
                    <GitBranch className="size-3" />
                    {d.branch}
                  </p>
                </div>
                {d.prNumber != null && (
                  <Badge
                    variant="outline"
                    className="hidden gap-1 font-normal sm:inline-flex"
                  >
                    <GitPullRequest className="size-3" />
                    {d.prNumber}
                  </Badge>
                )}
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {formatBuildDuration(d.buildDurationMs)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {timeAgoShort(d.createdAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
