import * as React from "react";
import {
  ArrowUpRight,
  Clock,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  ScrollText,
  Server,
  Zap,
} from "lucide-react";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";
import { DeploymentCreator } from "@/components/apps/deployment-creator";
import { DeploymentCover, WithCover } from "@/components/apps/deployment-cover";
import { describeAppSource } from "@/components/apps/app-source";
import { FrameworkBadge } from "@/components/apps/framework-badge";
import { CommitLink } from "@/components/apps/commit-link";
import { AppContainers } from "@/components/apps/app-containers";
import {
  effectiveFramework,
  supportsFrameworkDetection,
} from "@/lib/apps/framework-catalog";
import { productionHint } from "@/lib/apps/production-summary";
import type { getAppBySlug } from "@/lib/data/apps/listing";
import type { listDeployments } from "@/lib/data/deployments/deployment-queries";
import type { getAppCoverScreenshot } from "@/lib/data/deployments/screenshot";
import {
  formatBuildDuration,
  gitProfileUrl,
  repoCommitUrl,
  timeAgoShort,
} from "@/lib/utils";

type AppRow = NonNullable<Awaited<ReturnType<typeof getAppBySlug>>>;
type DeploymentRow = Awaited<ReturnType<typeof listDeployments>>[number];
type Shot = Awaited<ReturnType<typeof getAppCoverScreenshot>>;

function Field({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

const row = "flex min-w-0 items-center gap-1.5";

export function ProductionDeploymentCard({
  project,
  prod,
  shot,
  canConfigure,
}: {
  project: AppRow;
  prod: DeploymentRow | AppRow["latestDeployment"] | null | undefined;
  shot: Shot;
  canConfigure: boolean;
}) {
  const slug = project.slug;
  const src = describeAppSource(project);
  const hint = productionHint(project);
  const framework =
    supportsFrameworkDetection(project.build.buildMethod) &&
    effectiveFramework(project);
  const serverName = prod && "serverName" in prod ? prod.serverName : null;

  // Cells come in pairs; an odd one out takes the whole row, so no grid cell is left empty.
  const cells: { label: string; node: React.ReactNode }[] = !prod
    ? []
    : [
        {
          label: "Source",
          node: src.isGit ? (
            <>
              <p className={row}>
                <GitBranch className="size-3.5 shrink-0" />
                <span className="truncate">{prod.branch}</span>
              </p>
              <p className={`${row} mt-1.5`}>
                <GitCommitHorizontal className="size-3.5 shrink-0" />
                <CommitLink
                  sha={prod.commitSha}
                  url={repoCommitUrl(project.repo, prod.commitSha)}
                  signature={prod.commitSignature}
                  className="font-mono text-xs text-muted-foreground"
                />
                <span className="truncate text-muted-foreground">
                  {prod.commitMessage}
                </span>
              </p>
            </>
          ) : (
            <p className={row}>
              <src.Icon className="size-3.5 shrink-0" />
              <span className="truncate">{src.label}</span>
            </p>
          ),
        },
        ...(framework
          ? [{ label: "Framework", node: <FrameworkBadge id={framework} /> }]
          : []),
        {
          label: "Build time",
          node: (
            <p className={row}>
              <Clock className="size-3.5 shrink-0" />
              {formatBuildDuration(prod.buildDurationMs)}
            </p>
          ),
        },
        ...(framework
          ? []
          : [
              ...(serverName
                ? [
                    {
                      label: "Server",
                      node: (
                        <p className={row}>
                          <Server className="size-3.5 shrink-0" />
                          <span className="truncate">{serverName}</span>
                        </p>
                      ),
                    },
                  ]
                : []),
              {
                label: "Containers",
                node: (
                  <AppContainers
                    appId={project.id}
                    slug={slug}
                    serverName={serverName}
                  />
                ),
              },
            ]),
      ];

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-6 py-3">
        <CardTitle className="text-base">Production Deployment</CardTitle>
        <div className="flex items-center gap-2">
          {prod && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/apps/${slug}/deployments/${prod.id}`}>
                <ScrollText className="size-4" />
                Build Logs
              </Link>
            </Button>
          )}
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
      </CardHeader>
      <CardContent className="pt-6">
        {prod ? (
          <WithCover
            cover={
              shot && (
                <DeploymentCover
                  deploymentId={shot.deploymentId}
                  href={project.productionUrl || prod.url}
                  lightUrl={shot.lightUrl}
                  darkUrl={shot.darkUrl}
                  canRetake={shot.current && canConfigure}
                />
              )
            }
          >
            <div className="grid content-start gap-x-6 gap-y-5 sm:grid-cols-2">
              {project.productionUrl && (
                <Field label="Domain" wide>
                  <a
                    href={project.productionUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${row} w-fit max-w-full cursor-pointer font-medium hover:underline`}
                  >
                    <span className="truncate">
                      {project.productionUrl.replace(/^https?:\/\//, "")}
                    </span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </a>
                </Field>
              )}
              <Field label="Status">
                <StatusBadge status={prod.status} />
              </Field>
              <Field label="Created">
                <p className={row}>
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
              </Field>
              {cells.map((c, i) => (
                <Field
                  key={c.label}
                  label={c.label}
                  wide={i === 0 && cells.length % 2 === 1}
                >
                  {c.node}
                </Field>
              ))}
            </div>
          </WithCover>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              No production deployment yet.
            </p>
            <Field label="Source">
              <p className={row}>
                <src.Icon className="size-3.5 shrink-0" />
                <span className="truncate">{src.label}</span>
              </p>
            </Field>
          </div>
        )}
      </CardContent>
      {hint && (
        <div className="flex items-center gap-2 border-t border-border bg-surface px-6 py-3 text-sm text-muted-foreground">
          {hint.auto ? (
            <Zap className="size-3.5 shrink-0" />
          ) : (
            <RefreshCw className="size-3.5 shrink-0" />
          )}
          <p>
            {hint.parts.map((p, i) =>
              typeof p === "string" ? (
                p
              ) : (
                <code
                  key={i}
                  className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-xs text-foreground"
                >
                  {p.code}
                </code>
              ),
            )}
          </p>
        </div>
      )}
    </Card>
  );
}
