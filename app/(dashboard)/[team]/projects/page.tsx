import { redirect } from "next/navigation";

// ProjectsIndex redirects old bookmarks: Projects have no page, they live on the Overview (`/?project=<id>`).
export default async function ProjectsIndex(
  props: PageProps<"/[team]/projects">,
) {
  const { team } = await props.params;
  redirect(`/${team}`);
}
