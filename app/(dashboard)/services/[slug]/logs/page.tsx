import { notFound } from "next/navigation";
import { getServiceBySlug } from "@/lib/data/services";
import { getLogsInfo } from "@/lib/data/console";
import { PageHeader } from "@/components/shared/page-header";
import { LiveLogs } from "@/components/services/live-logs";

export const metadata = { title: "Logs" };

export default async function ServiceLogsPage(
  props: PageProps<"/services/[slug]/logs">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  // Reuse the console's instance discovery: the same containers, default
  // (exposed/running) first, so the logs picker matches the console's. Logs
  // doesn't use the shell label, so skip that probe (getLogsInfo, not
  // getAttachInfo) to keep this render path off the ≤4 extra docker exec calls.
  const info = await getLogsInfo(project.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Logs"
        description="Live runtime output from the running container (docker logs -f)."
      />

      {/* Follows the project's live running state: the log stream appears/
          disappears as the container starts/stops, no reload. */}
      <LiveLogs
        serviceId={project.id}
        initialInstances={info?.running ? info.instances : null}
        initialRunning={!!info?.running}
      />
    </div>
  );
}
