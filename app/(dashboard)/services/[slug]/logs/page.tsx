import { notFound } from "next/navigation";
import { getServiceBySlug } from "@/lib/data/services";
import { getLogsInfo } from "@/lib/data/console";
import { getLogs } from "@/lib/data/deployments";
import { PageHeader } from "@/components/shared/page-header";
import { LiveLogs } from "@/components/services/live-logs";

export const metadata = { title: "Logs" };

export default async function ServiceLogsPage(
  props: PageProps<"/services/[slug]/logs">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  const latest = project.latestDeployment;
  // Reuse the console's instance discovery: the same containers, default
  // (exposed/running) first, so the logs picker matches the console's. Logs
  // doesn't use the shell label, so skip that probe (getLogsInfo, not
  // getAttachInfo) to keep this render path off the ≤4 extra docker exec calls.
  // Also seed the most recent build's logs so a stopped project (no running
  // container to stream from) still shows something instead of a dead end.
  const [info, buildLogs] = await Promise.all([
    getLogsInfo(project.id),
    latest ? getLogs(latest.id) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Logs"
        description="Live runtime output while the container runs, or the most recent build's logs when it isn't."
      />

      {/* Follows the service's live running state: the runtime stream shows while
          the container runs, and falls back to the most recent build's logs the
          moment it stops — all without a reload. */}
      <LiveLogs
        serviceId={project.id}
        initialInstances={info?.running ? info.instances : null}
        initialRunning={!!info?.running}
        latestDeployment={latest ? { id: latest.id, status: latest.status } : null}
        initialBuildLogs={buildLogs}
      />
    </div>
  );
}
