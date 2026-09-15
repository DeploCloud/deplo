import { redirect } from "next/navigation";

export default async function ServersRedirect(
  props: PageProps<"/[team]/servers">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/servers`);
}
