import { notFound } from "next/navigation";
import { HardDrive } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { canMountHostVolumes } from "@/lib/membership";
import { hasAppCapability } from "@/lib/data/node-access";
import { containerWorkdir } from "@/lib/apps/volume-model";
import { composeDeclaredMounts } from "@/lib/apps/compose-storage";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { StorageSettingsForm } from "@/components/apps/settings/storage-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import {
  composeServiceNames,
  detectDefaultApp,
} from "@/lib/deploy/compose-stack/compose-read";
import { usesComposeStack } from "@/lib/utils";

export const metadata = { title: "Storage" };

export default async function AppStorageSettingsPage(
  props: PageProps<"/[team]/apps/[slug]/settings/storage">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const isComposeStack = usesComposeStack({
    source: project.source,
    compose: project.compose,
    repo: project.repo,
    dockerImage: project.dockerImage,
  });
  const composeServices = isComposeStack
    ? composeServiceNames(project.compose)
    : [];
  const mayBind = await canMountHostVolumes();
  const mayEditFiles = await hasAppCapability(project.id, "configure_apps");

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={HardDrive}
        title="Storage"
        docs="storage.overview"
      />
      <CapabilityFieldset cap="configure_apps">
        <StorageSettingsForm
          appId={project.id}
          slug={project.slug}
          volumes={project.volumes ?? []}
          composeMounts={composeDeclaredMounts(project)}
          composeServices={composeServices}
          defaultComposeService={
            isComposeStack ? detectDefaultApp(project.compose)?.service : null
          }
          canMountHostVolumes={mayBind}
          canManageFiles={mayEditFiles}
          containerWorkdir={containerWorkdir(
            project.source,
            project.build.rootDirectory,
          )}
        />
      </CapabilityFieldset>
    </section>
  );
}
