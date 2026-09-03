import { redirect } from "next/navigation";

/** The page moved to Settings, Migrations. Old links keep working. */
export default async function ImportRedirect(
  props: PageProps<"/[team]/settings/import">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/migrations`);
}
