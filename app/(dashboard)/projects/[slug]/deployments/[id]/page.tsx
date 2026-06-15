import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, GitBranch, Clock, ExternalLink } from "lucide-react";
import { getProjectBySlug } from "@/lib/data/projects";
import { getDeployment, getLogs } from "@/lib/data/deployments";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { StatusBadge } from "@/components/shared/status-badge";
import { CopyButton } from "@/components/shared/copy-button";
import { CodeBlock } from "@/components/shared/code-block";
import { cn, timeAgo } from "@/lib/utils";
import { generateAppCompose } from "@/lib/deploy/compose";
import { traefikLabelsYaml } from "@/lib/deploy/traefik";

export const metadata = { title: "Deployment" };

const LEVEL_CLASS: Record<string, string> = {
  command: "text-zinc-100 font-medium",
  info: "text-zinc-400",
  warn: "text-[var(--warning)]",
  error: "text-destructive",
  debug: "text-muted-foreground",
};

export default async function DeploymentDetailPage(
  props: PageProps<"/projects/[slug]/deployments/[id]">
) {
  const { slug, id } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const deployment = await getDeployment(id);
  if (!deployment || deployment.projectId !== project.id) notFound();

  const logs = await getLogs(id);
  const logText = logs
    .map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.text}`)
    .join("\n");

  const domains = project.productionUrl
    ? [project.productionUrl.replace(/^https?:\/\//, "")]
    : [`${project.slug}.deplo.app`];
  const compose = generateAppCompose({
    name: project.slug,
    build: project.build,
    domains,
  });
  const labels = traefikLabelsYaml({ name: project.slug, domains, port: project.build.port }, 0);

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        asChild
        className="-ml-2 text-muted-foreground"
      >
        <Link href={`/projects/${slug}`}>
          <ArrowLeft className="size-4" />
          Back to project
        </Link>
      </Button>

      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Meta label="Status">
            <StatusBadge status={deployment.status} />
          </Meta>
          <Meta label="Environment">
            <Badge variant={deployment.environment === "production" ? "default" : "secondary"}>
              {deployment.environment}
            </Badge>
          </Meta>
          <Meta label="Source">
            <span className="flex items-center gap-1.5 text-sm">
              <GitBranch className="size-3.5" />
              {deployment.branch}
              <code className="font-mono text-xs text-muted-foreground">
                {deployment.commitSha.slice(0, 7)}
              </code>
            </span>
          </Meta>
          <Meta label="Build time">
            <span className="flex items-center gap-1.5 text-sm">
              <Clock className="size-3.5" />
              {deployment.buildDurationMs
                ? `${Math.round(deployment.buildDurationMs / 1000)}s`
                : "—"}
            </span>
          </Meta>
          <div className="sm:col-span-2">
            <p className="text-xs text-muted-foreground">Commit</p>
            <p className="text-sm">{deployment.commitMessage}</p>
          </div>
          <Meta label="Created">
            <span className="text-sm">
              {timeAgo(deployment.createdAt)} by {deployment.creator}
            </span>
          </Meta>
          <div className="flex items-end">
            <Button variant="outline" size="sm" asChild>
              <a href={deployment.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
                Visit
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="logs">
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="logs">Build Logs</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="config">Configuration</UnderlineTabsTrigger>
        </UnderlineTabsList>

        <TabsContent value="logs">
          <div className="overflow-hidden rounded-xl border border-border bg-[#0a0a0a]">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-xs text-muted-foreground">
                {logs.length} lines
              </span>
              <CopyButton value={logText} label="Copy logs" />
            </div>
            <div className="max-h-[480px] overflow-y-auto p-4 font-mono text-xs leading-relaxed">
              {logs.map((l, i) => (
                <div key={i} className="flex gap-3">
                  <span className="shrink-0 select-none text-zinc-600">
                    {new Date(l.ts).toLocaleTimeString()}
                  </span>
                  <span className={cn(LEVEL_CLASS[l.level] ?? "text-zinc-300")}>
                    {l.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="config" className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Generated docker-compose.yml</p>
            <CodeBlock code={compose} filename="docker-compose.yml" />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Traefik routing labels</p>
            <CodeBlock code={labels} filename="traefik.labels" />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}
