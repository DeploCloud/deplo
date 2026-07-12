import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps";
import { DangerSettings } from "@/components/apps/settings/danger-settings";

export const metadata = { title: "Danger zone" };

export default async function AppDangerSettingsPage(
  props: PageProps<"/apps/[slug]/settings/danger">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  return <DangerSettings appId={project.id} name={project.name} />;
}
