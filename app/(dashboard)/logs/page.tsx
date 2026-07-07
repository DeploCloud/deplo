import { ScrollText } from "lucide-react";
import { listDeployments, getLogs } from "@/lib/data/deployments";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import type { LogLine } from "@/lib/types";
import { LogViewer, type DeploymentSummary } from "./log-viewer";

export const metadata = { title: "Logs" };

export default async function LogsPage() {
  const deployments = await listDeployments();
  const recent = deployments.slice(0, 15);

  const logsById: Record<string, LogLine[]> = Object.fromEntries(
    await Promise.all(
      recent.map(async (d) => [d.id, await getLogs(d.id)] as const)
    )
  );

  const summaries: DeploymentSummary[] = recent.map((d) => ({
    id: d.id,
    serviceName: d.serviceName,
    serviceSlug: d.serviceSlug,
    commitMessage: d.commitMessage,
    status: d.status,
    createdAt: d.createdAt,
    branch: d.branch,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Logs"
        description="Inspect build and runtime logs from your most recent deployments."
      />

      {summaries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No logs yet"
          description="Deploy a project to start streaming build and runtime logs here."
        />
      ) : (
        <LogViewer deployments={summaries} logsById={logsById} />
      )}
    </div>
  );
}
