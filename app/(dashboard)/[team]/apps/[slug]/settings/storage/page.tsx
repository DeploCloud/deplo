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

  // Volumes are settable for EVERY source.
  const isComposeStack = usesComposeStack({
    source: project.source,
    compose: project.compose,
    repo: project.repo,
    dockerImage: project.dockerImage,
  });
  const composeServices = isComposeStack
    ? composeServiceNames(project.compose)
    : [];
  // A Bind stays selectable without the grant - the editor says saving one needs it.
  const mayBind = await canMountHostVolumes();
  // A File entry's content is app configuration, so it rides the page's configure_apps.
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
          // A stack's own yaml is the only storage most migrated apps have - without it the tab claims the data is thrown away.
          composeMounts={composeDeclaredMounts(project)}
          composeServices={composeServices}
          // The same fallback the renderer uses, so the placeholder names the service a blank row mounts into.
          defaultComposeService={
            isComposeStack ? detectDefaultApp(project.compose)?.service : null
          }
          canMountHostVolumes={mayBind}
          canManageFiles={mayEditFiles}
          // The generated Dockerfile's WORKDIR - a path the non-expert cannot guess, so the editor states it.
          containerWorkdir={containerWorkdir(
            project.source,
            project.build.rootDirectory,
          )}
        />
      </CapabilityFieldset>
    </section>
  );
}
