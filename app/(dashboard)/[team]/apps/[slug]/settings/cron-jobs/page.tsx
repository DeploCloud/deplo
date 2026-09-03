import { redirect } from "next/navigation";

/**
 * The cron jobs switch now lives under Advanced settings, in the "Advanced
 * features" card next to the Console. This stub keeps the old
 * `/settings/cron-jobs` path working for existing links and bookmarks.
 */
export default async function AppCronSettingsRedirect(
  props: PageProps<"/apps/[slug]/settings/cron-jobs">,
) {
  const { slug } = await props.params;
  redirect(`/apps/${slug}/settings/advanced`);
}
