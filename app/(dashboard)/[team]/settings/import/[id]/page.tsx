import { redirect } from "next/navigation";

// ImportRunRedirect - a finished run has no page of its own; the report opens in a dialog, so a bookmarked run lands on History.
export default async function ImportRunRedirect(
  props: PageProps<"/[team]/settings/import/[id]">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/migrations?tab=history`);
}
