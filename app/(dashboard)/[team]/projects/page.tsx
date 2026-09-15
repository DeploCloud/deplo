import { redirect } from "next/navigation";

export default async function ProjectsIndex(
  props: PageProps<"/[team]/projects">,
) {
  const { team } = await props.params;
  redirect(`/${team}`);
}
