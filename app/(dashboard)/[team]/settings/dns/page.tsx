import { redirect } from "next/navigation";

export default async function AutomaticDnsMoved(
  props: PageProps<"/[team]/settings/dns">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings#automatic-dns`);
}
