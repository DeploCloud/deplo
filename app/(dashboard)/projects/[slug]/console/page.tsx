import { notFound } from "next/navigation";
import { TerminalSquare } from "lucide-react";
import { getProjectBySlug } from "@/lib/data/projects";
import { getAttachInfo } from "@/lib/data/console";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerConsole } from "@/components/projects/container-console";

export const metadata = { title: "Console" };

export default async function ProjectConsolePage(
  props: PageProps<"/projects/[slug]/console">
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const info = await getAttachInfo(project.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Console"
        description="Run commands in the running container (docker exec)."
      />

      {info?.running ? (
        <ContainerConsole
          projectId={project.id}
          containerName={info.containerName}
          image={info.image}
          shell={info.shell}
          instances={info.instances}
        />
      ) : (
        <EmptyState
          icon={TerminalSquare}
          title="Container is not running"
          description="The console is available once the project has a running deployment. Deploy or redeploy this project, then attach."
        />
      )}
    </div>
  );
}
