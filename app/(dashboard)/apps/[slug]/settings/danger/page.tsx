import { redirect } from "next/navigation";

/**
 * The Danger Zone now lives under Advanced settings. This stub keeps the old
 * `/settings/danger` path working for existing links and bookmarks.
 */
export default async function AppDangerSettingsRedirect(
  props: PageProps<"/apps/[slug]/settings/danger">,
) {
  const { slug } = await props.params;
  redirect(`/apps/${slug}/settings/advanced`);
}
