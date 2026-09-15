import { redirect } from "next/navigation";

export default async function AppCronSettingsRedirect(
  props: PageProps<"/[team]/apps/[slug]/settings/cron-jobs">,
) {
  const { team, slug } = await props.params;
  redirect(`/${team}/apps/${slug}/settings/advanced`);
}
