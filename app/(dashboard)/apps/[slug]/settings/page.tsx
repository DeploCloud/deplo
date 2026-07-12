import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { isGithubRepo } from "@/lib/apps/favicon-shared";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { GeneralSettingsForm } from "@/components/apps/settings/general-settings-form";

export const metadata = { title: "General" };

export default async function AppGeneralSettingsPage(
  props: PageProps<"/apps/[slug]/settings">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  return (
    <section className="space-y-4">
      <SettingsSection icon={Settings2} title="General" />
      <GeneralSettingsForm
        appId={project.id}
        name={project.name}
        logo={project.logo}
        detectable={project.source === "upload" || isGithubRepo(project.repo)}
      />
    </section>
  );
}
