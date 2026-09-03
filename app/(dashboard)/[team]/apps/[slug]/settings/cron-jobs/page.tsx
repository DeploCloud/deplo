import { redirect } from "next/navigation";

/**
 * The cron jobs switch now lives under Advanced settings, in the "Advanced
 * features" card next to the Console. This stub keeps the old
 * `/settings/cron-jobs` path working for existing links and bookmarks.
 */
export default async function AppCronSettingsRedirect(
  props: PageProps<"/[team]/apps/[slug]/settings/cron-jobs">,
) {
  const { team, slug } = await props.params;
  redirect(`/${team}/apps/${slug}/settings/advanced`);
}
