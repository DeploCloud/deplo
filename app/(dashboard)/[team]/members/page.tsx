import { redirect } from "next/navigation";

export default async function MembersIndex(
  props: PageProps<"/[team]/members">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/members`);
}
