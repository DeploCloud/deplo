import { notFound } from "next/navigation";
import { getServiceBySlug } from "@/lib/data/services";
import { DangerSettings } from "@/components/services/settings/danger-settings";

export const metadata = { title: "Danger zone" };

export default async function ServiceDangerSettingsPage(
  props: PageProps<"/services/[slug]/settings/danger">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  return <DangerSettings serviceId={project.id} name={project.name} />;
}
