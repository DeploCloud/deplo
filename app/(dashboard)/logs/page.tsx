import { listDeployments, getLogs } from "@/lib/data/deployments";
import { LogsGraphic } from "@/components/apps/logs-graphic";
import { hasAppCapability } from "@/lib/data/node-access";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import type { LogLine } from "@/lib/types";
import { LogViewer, type DeploymentSummary } from "./log-viewer";

export const metadata = { title: "Logs" };

export default async function LogsPage() {
  const deployments = await listDeployments();
  const recent = deployments.slice(0, 15);

  // `view_logs` is held per app (ADR-0016), and a deployment list can span apps
  // the viewer reads and apps they don't. `getLogs` answers an empty list for
  // the ones they can't - indistinguishable from a build that printed nothing -
  // so resolve the reason here and let the viewer say which it is.
  const readable = await Promise.all(
    recent.map((d) => hasAppCapability(d.appId, "view_logs")),
  );
  const closedIds = recent.filter((_, i) => !readable[i]).map((d) => d.id);
  const logsById: Record<string, LogLine[]> = Object.fromEntries(
    await Promise.all(
      recent.map(
        async (d, i) => [d.id, readable[i] ? await getLogs(d.id) : []] as const,
      ),
    ),
  );

  const summaries: DeploymentSummary[] = recent.map((d) => ({
    id: d.id,
    serviceName: d.serviceName,
    appSlug: d.appSlug,
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
          graphic={<LogsGraphic />}
          title="No logs yet"
          description="Deploy an app to start streaming build and runtime logs here."
        />
      ) : (
        <LogViewer
          deployments={summaries}
          logsById={logsById}
          closedIds={closedIds}
        />
      )}
    </div>
  );
}
