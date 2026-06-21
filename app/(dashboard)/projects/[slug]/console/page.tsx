import { notFound } from "next/navigation";
import { getProjectBySlug } from "@/lib/data/projects";
import { getConsoleInfo } from "@/lib/data/console";
import { PageHeader } from "@/components/shared/page-header";
import { LiveConsole } from "@/components/projects/live-console";

export const metadata = { title: "Console" };

export default async function ProjectConsolePage(
  props: PageProps<"/projects/[slug]/console">
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  // No shell probe here — getConsoleInfo skips it so the console renders
  // instantly. ContainerConsole resolves the shell label after mount and
  // appends the distroless notice lazily if the container has no shell.
  const info = await getConsoleInfo(project.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Console"
        description="Run commands in the running container (docker exec)."
      />

      {/* Follows the project's live running state: the terminal appears/
          disappears as the container starts/stops, no reload. */}
      <LiveConsole
        projectId={project.id}
        initialInfo={
          info?.running
            ? {
                containerName: info.containerName,
                image: info.image,
                instances: info.instances,
              }
            : null
        }
        initialRunning={!!info?.running}
      />
    </div>
  );
}
