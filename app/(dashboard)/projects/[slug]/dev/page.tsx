import { notFound } from "next/navigation";
import { getProjectBySlug } from "@/lib/data/projects";
import { listServers } from "@/lib/data/servers";
import { getDevInfo } from "@/lib/data/dev";
import { listDevSshUsers } from "@/lib/data/dev-ssh";
import { resolveServerIp } from "@/lib/deploy/domains";
import { DevModeFields } from "@/components/projects/dev-mode-fields";

export const metadata = { title: "Dev Mode" };

export default async function ProjectDevPage(
  props: PageProps<"/projects/[slug]/dev">
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const [devInfo, devSshUsers, allServers] = await Promise.all([
    getDevInfo(project.id),
    listDevSshUsers(project.id),
    listServers(),
  ]);
  if (!devInfo) notFound();
  const server = allServers.find((s) => s.id === project.serverId);
  const devHost = resolveServerIp(server);

  return (
    <DevModeFields
      projectId={project.id}
      host={devHost}
      dev={devInfo}
      sshUsers={devSshUsers}
    />
  );
}
