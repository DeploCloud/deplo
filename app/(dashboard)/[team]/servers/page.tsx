import { redirect } from "next/navigation";

// ServersRedirect keeps the old /servers links working: Servers is a Settings section now.
export default async function ServersRedirect(
  props: PageProps<"/[team]/servers">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/servers`);
}
