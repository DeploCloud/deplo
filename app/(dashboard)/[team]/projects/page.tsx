import { redirect } from "next/navigation";

/**
 * Projects no longer have a page of their own: containers live on the Overview
 * (`/`), which also hosts each container's drill-in view (`/?project=<id>`).
 * This stub only keeps old bookmarks working.
 */
export default async function ProjectsIndex(
  props: PageProps<"/[team]/projects">,
) {
  const { team } = await props.params;
  redirect(`/${team}`);
}
