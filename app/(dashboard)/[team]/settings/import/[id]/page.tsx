import { redirect } from "next/navigation";

/**
 * A finished run no longer has a page of its own - the report opens in a dialog,
 * from the wizard that just ran it or from the History tab. A bookmarked run
 * lands on that tab.
 */
export default async function ImportRunRedirect(
  props: PageProps<"/[team]/settings/import/[id]">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/migrations?tab=history`);
}
