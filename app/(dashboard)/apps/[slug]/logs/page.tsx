import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps";
import { getLogsInfo } from "@/lib/data/console";
import { getLogs } from "@/lib/data/deployments";
import { PageHeader } from "@/components/shared/page-header";
import { LiveLogs } from "@/components/apps/live-logs";

export const metadata = { title: "Logs" };

export default async function AppLogsPage(
  props: PageProps<"/apps/[slug]/logs">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const latest = project.latestDeployment;
  // Reuse the console's instance discovery: the same containers, the app's own
  // one first, so the logs picker matches the console's. Logs doesn't use the
  // shell label, so skip that probe (getLogsInfo, not getAttachInfo) to keep this
  // render path off the ≤4 extra docker exec calls. Also seed the most recent
  // build's logs, for an app that has no container at all to read from.
  const [info, buildLogs] = await Promise.all([
    getLogsInfo(project.id),
    latest ? getLogs(latest.id) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Logs"
        description="Live output from the app's container — including while it is crash-looping — or the most recent build's logs when there is no container at all."
      />

      {/* Seeded with whatever containers the host has, running or not:
          `docker logs` outlives the process, so a dead or restarting container
          still streams. Only an app with NO container falls back to build logs. */}
      <LiveLogs
        appId={project.id}
        initialInstances={info?.instances ?? []}
        initialStreamable={!!info?.streamable}
        latestDeployment={latest ? { id: latest.id, status: latest.status } : null}
        initialBuildLogs={buildLogs}
      />
    </div>
  );
}
