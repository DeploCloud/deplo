import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { getServiceBySlug } from "@/lib/data/services";
import { isGithubRepo } from "@/lib/services/favicon-shared";
import { SettingsSection } from "@/components/services/settings/settings-shared";
import { GeneralSettingsForm } from "@/components/services/settings/general-settings-form";

export const metadata = { title: "General" };

export default async function ServiceGeneralSettingsPage(
  props: PageProps<"/services/[slug]/settings">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  return (
    <section className="space-y-4">
      <SettingsSection icon={Settings2} title="General" />
      <GeneralSettingsForm
        serviceId={project.id}
        name={project.name}
        logo={project.logo}
        detectable={project.source === "upload" || isGithubRepo(project.repo)}
      />
    </section>
  );
}
