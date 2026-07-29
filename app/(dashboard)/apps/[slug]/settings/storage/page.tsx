import { notFound } from "next/navigation";
import { HardDrive } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { StorageSettingsForm } from "@/components/apps/settings/storage-settings-form";
import {
  composeServiceNames,
  detectDefaultApp,
} from "@/lib/deploy/compose-stack";
import { usesComposeStack } from "@/lib/utils";

export const metadata = { title: "Storage" };

export default async function AppStorageSettingsPage(
  props: PageProps<"/apps/[slug]/settings/storage">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // Volumes are settable for EVERY source. A compose stack has more than one
  // possible target, so its service names ride along and each row picks one;
  // empty list ⇒ single-container, one implicit service, no picker. Derived from
  // the SAVED source (the deploy source is edited on its own page).
  const isComposeStack = usesComposeStack({
    source: project.source,
    compose: project.compose,
    repo: project.repo,
    dockerImage: project.dockerImage,
  });
  const composeServices = isComposeStack
    ? composeServiceNames(project.compose)
    : [];

  return (
    <section className="space-y-4">
      <SettingsSection icon={HardDrive} title="Storage" />
      <StorageSettingsForm
        appId={project.id}
        slug={project.slug}
        volumes={project.volumes ?? []}
        composeServices={composeServices}
        // The same heuristic the renderer falls back to, so the picker's
        // placeholder names the service a blank row will actually mount into.
        defaultComposeService={
          isComposeStack ? detectDefaultApp(project.compose)?.service : null
        }
      />
    </section>
  );
}
