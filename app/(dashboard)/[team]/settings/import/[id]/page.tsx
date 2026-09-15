import { redirect } from "next/navigation";

export default async function ImportRunRedirect(
  props: PageProps<"/[team]/settings/import/[id]">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/migrations?tab=history`);
}
