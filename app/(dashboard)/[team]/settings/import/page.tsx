import { redirect } from "next/navigation";

export default async function ImportRedirect(
  props: PageProps<"/[team]/settings/import">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/migrations`);
}
