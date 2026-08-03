import { notFound } from "next/navigation";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { getToken } from "@/lib/data/tokens";
import { listProjects } from "@/lib/data/projects";
import { TokenEditor } from "@/components/settings/tokens/token-editor";

export async function generateMetadata(
  props: PageProps<"/settings/tokens/[id]">,
) {
  const { id } = await props.params;
  const token = await getToken(id);
  return { title: token ? `Settings · ${token.name}` : "Settings · API tokens" };
}

export default async function TokenPage(
  props: PageProps<"/settings/tokens/[id]">,
) {
  const { id } = await props.params;
  const [token, canManage, canGrantInstanceAdmin, projects] = await Promise.all([
    getToken(id),
    hasCapability("manage_tokens"),
    isInstanceAdmin(),
    listProjects(),
  ]);
  // A token of another team resolves to nothing here, exactly as it does in the
  // data layer — there is no id to guess your way into.
  if (!token) notFound();

  return (
    <TokenEditor
      mode="edit"
      token={token}
      projects={projects.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color ?? null,
        appCount: p.appCount,
      }))}
      canManage={canManage}
      canGrantInstanceAdmin={canGrantInstanceAdmin}
      publicUrl={process.env.DEPLO_PUBLIC_URL ?? ""}
    />
  );
}
