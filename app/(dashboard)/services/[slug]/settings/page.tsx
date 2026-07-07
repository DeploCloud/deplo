import { notFound } from "next/navigation";
import { getServiceBySlug } from "@/lib/data/services";
import { listServersForCurrentTeam } from "@/lib/data/servers";
import { listGithubInstallations } from "@/lib/data/github";
import { listBasicAuthUsers } from "@/lib/data/basic-auth";
import { BuildSettingsForm } from "@/components/services/build-settings-form";

export const metadata = { title: "Service Settings" };

export default async function ServiceSettingsPage(
  props: PageProps<"/services/[slug]/settings">
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  const servers = (await listServersForCurrentTeam()).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
  }));
  const installations = await listGithubInstallations();
  const basicAuthUsers = await listBasicAuthUsers(project.id);

  return (
    <BuildSettingsForm
      serviceId={project.id}
      slug={project.slug}
      name={project.name}
      logo={project.logo}
      framework={project.framework}
      build={project.build}
      autoDeploy={project.autoDeploy}
      source={project.source}
      repo={project.repo}
      installations={installations}
      dockerImage={project.dockerImage}
      upload={
        project.upload
          ? {
              filename: project.upload.filename,
              size: project.upload.size,
              uploadedAt: project.upload.uploadedAt,
            }
          : null
      }
      compose={project.compose}
      volumes={project.volumes ?? []}
      serverId={project.serverId}
      servers={servers}
      basicAuthUsers={basicAuthUsers}
    />
  );
}
