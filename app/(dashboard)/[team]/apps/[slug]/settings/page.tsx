import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { faviconSourceKind } from "@/lib/apps/favicon-shared";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { GeneralSettingsForm } from "@/components/apps/settings/general-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";

export const metadata = { title: "General" };

export default async function AppGeneralSettingsPage(
  props: PageProps<"/[team]/apps/[slug]/settings">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // "Detect from source" is offered for every app whose files Deplo can
  // actually read: a GitHub repo, an uploaded archive, or, for a compose stack,
  // the app's own files on its server. Same dispatch the detector runs.
  const detectable = faviconSourceKind(project) !== "none";

  return (
    <section className="space-y-4">
      <SettingsSection icon={Settings2} title="General" docs="build.settings" />
      <CapabilityFieldset cap="configure_apps">
        <GeneralSettingsForm
          appId={project.id}
          name={project.name}
          logo={project.logo}
          detectable={detectable}
        />
      </CapabilityFieldset>
    </section>
  );
}
