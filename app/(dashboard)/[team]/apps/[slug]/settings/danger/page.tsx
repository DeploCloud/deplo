import { redirect } from "next/navigation";

/**
 * The Danger Zone now lives under Advanced settings. This stub keeps the old
 * `/settings/danger` path working for existing links and bookmarks.
 */
export default async function AppDangerSettingsRedirect(
  props: PageProps<"/[team]/apps/[slug]/settings/danger">,
) {
  const { team, slug } = await props.params;
  redirect(`/${team}/apps/${slug}/settings/advanced`);
}
