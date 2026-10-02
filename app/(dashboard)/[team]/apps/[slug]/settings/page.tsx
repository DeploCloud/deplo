import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { listServerChoices } from "@/lib/data/servers/roster";
import { neighboursOnNetwork } from "@/lib/data/name-clash";
import { faviconSourceKind } from "@/lib/apps/favicon-shared";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { GeneralSettingsForm } from "@/components/apps/settings/general-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import { AppServerCard } from "@/components/shared/server-move-card";

export const metadata = { title: "General" };

export default async function AppGeneralSettingsPage(
  props: PageProps<"/[team]/apps/[slug]/settings">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const detectable = faviconSourceKind(project) !== "none";
  const [servers, neighbours] = await Promise.all([
    listServerChoices(),
    neighboursOnNetwork(
      {
        teamId: project.teamId,
        environmentId: project.environmentId ?? null,
        serverId: project.serverId,
      },
      project.id,
    ),
  ]);

  return (
    <section className="space-y-4">
      <SettingsSection icon={Settings2} title="General" docs="build.settings" />
      <CapabilityFieldset cap="configure_apps">
        <GeneralSettingsForm
          appId={project.id}
          name={project.name}
          logo={project.logo}
          logoTone={project.logoTone}
          detectable={detectable}
        />
        <AppServerCard
          appId={project.id}
          name={project.name}
          serverId={project.serverId}
          servers={servers}
          neighbours={neighbours}
        />
      </CapabilityFieldset>
    </section>
  );
}
