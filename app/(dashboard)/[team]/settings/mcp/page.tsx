import { redirect } from "next/navigation";

import { querySuffix } from "@/lib/legacy-redirect";

export default async function McpSettingsMoved(
  props: PageProps<"/[team]/settings/mcp">,
) {
  const [{ team }, query] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  redirect(`/${team}/settings/agents${querySuffix(query)}`);
}
