import { redirect } from "next/navigation";

export default async function McpSettingsMoved(
  props: PageProps<"/[team]/settings/mcp">,
) {
  const { team } = await props.params;
  redirect(`/${team}/settings/agents`);
}
