import { redirect } from "next/navigation";

// MembersIndex is a legacy redirect stub: Members lives under Settings → Team.
export default async function MembersIndex(
  props: PageProps<"/[team]/members">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/members`);
}
