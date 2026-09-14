import { redirect } from "next/navigation";

// AppCronSettingsRedirect keeps the old /settings/cron-jobs links working; the switch moved to Advanced settings.
export default async function AppCronSettingsRedirect(
  props: PageProps<"/[team]/apps/[slug]/settings/cron-jobs">,
) {
  const { team, slug } = await props.params;
  redirect(`/${team}/apps/${slug}/settings/advanced`);
}
