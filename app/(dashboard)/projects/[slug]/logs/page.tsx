import { notFound } from "next/navigation";
import { ScrollText } from "lucide-react";
import { getProjectBySlug } from "@/lib/data/projects";
import { getLogsInfo } from "@/lib/data/console";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerLogs } from "@/components/projects/container-logs";

export const metadata = { title: "Logs" };

export default async function ProjectLogsPage(
  props: PageProps<"/projects/[slug]/logs">,
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
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

      {info?.running ? (
        <ContainerLogs projectId={project.id} instances={info.instances} />
      ) : (
        <EmptyState
          icon={ScrollText}
          title="Container is not running"
          description="Runtime logs stream from a running container. Deploy or redeploy this project to start streaming its output."
        />
      )}
    </div>
  );
}
