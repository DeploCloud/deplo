import { redirect } from "next/navigation";

export default async function DatabaseCronSettingsRedirect(
  props: PageProps<"/[team]/storage/databases/[id]/settings/cron-jobs">,
) {
  const { team, id } = await props.params;
  redirect(`/${team}/storage/databases/${id}/settings/advanced`);
}
