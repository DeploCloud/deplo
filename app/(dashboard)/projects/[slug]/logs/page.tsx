import { notFound } from "next/navigation";
import { ScrollText } from "lucide-react";
import { getProjectBySlug } from "@/lib/data/projects";
import { getAttachInfo } from "@/lib/data/console";
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
  // (exposed/running) first, so the logs picker matches the console's.
  const info = await getAttachInfo(project.id);

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
