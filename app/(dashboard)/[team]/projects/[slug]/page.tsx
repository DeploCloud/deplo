import { redirect } from "next/navigation";
import { getProjectBySlug } from "@/lib/data/projects/read";

// ProjectDetail is a redirect stub: the Project page is gone, so old slug URLs forward to the Overview drill-in.
export default async function ProjectDetail(
  props: PageProps<"/[team]/projects/[slug]">,
) {
  const { team, slug } = await props.params;
  const project = await getProjectBySlug(slug);
  redirect(project ? `/${team}?project=${project.id}` : `/${team}`);
}
