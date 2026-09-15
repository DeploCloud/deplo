import { redirect } from "next/navigation";

export default async function AppDangerSettingsRedirect(
  props: PageProps<"/[team]/apps/[slug]/settings/danger">,
) {
  const { team, slug } = await props.params;
  redirect(`/${team}/apps/${slug}/settings/advanced`);
}
