import { redirect } from "next/navigation";

/** The database twin of the app's stub: the switch moved to Advanced settings. */
export default async function DatabaseCronSettingsRedirect(
  props: PageProps<"/[team]/storage/databases/[id]/settings/cron-jobs">,
) {
  const { team, id } = await props.params;
  redirect(`/${team}/storage/databases/${id}/settings/advanced`);
}
