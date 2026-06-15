import { notFound } from "next/navigation";
import { getProjectBySlug } from "@/lib/data/projects";
import { listEnv } from "@/lib/data/env";
import { EnvManager } from "@/components/env/env-manager";

export const metadata = { title: "Environment Variables" };

export default async function ProjectEnvPage(
  props: PageProps<"/projects/[slug]/environment">
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const vars = await listEnv(project.id);

  return <EnvManager projectId={project.id} vars={vars} />;
}
