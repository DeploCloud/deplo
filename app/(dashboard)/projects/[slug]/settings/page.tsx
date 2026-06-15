import { notFound } from "next/navigation";
import { getProjectBySlug } from "@/lib/data/projects";
import { listServers } from "@/lib/data/servers";
import { BuildSettingsForm } from "@/components/projects/build-settings-form";

export const metadata = { title: "Project Settings" };

export default async function ProjectSettingsPage(
  props: PageProps<"/projects/[slug]/settings">
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const servers = (await listServers()).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
  }));

  return (
    <BuildSettingsForm
      projectId={project.id}
      name={project.name}
      framework={project.framework}
      build={project.build}
      autoDeploy={project.autoDeploy}
      source={project.source}
      repo={project.repo}
      dockerImage={project.dockerImage}
      serverId={project.serverId}
      servers={servers}
    />
  );
}
