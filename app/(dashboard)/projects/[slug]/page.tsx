import { redirect } from "next/navigation";
import { getProjectBySlug } from "@/lib/data/projects";

/**
 * The former Project detail page. Projects are now browsed on the Overview
 * (`/?project=<id>` drill-in, environments included), so this stub resolves the
 * old slug URL and forwards there — keeping bookmarks and stale links working.
 */
export default async function ProjectDetail(
  props: PageProps<"/projects/[slug]">,
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  redirect(project ? `/?project=${project.id}` : "/");
}
