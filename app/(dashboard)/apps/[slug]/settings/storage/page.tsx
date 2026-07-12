import { notFound } from "next/navigation";
import { HardDrive } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { StorageSettingsForm } from "@/components/apps/settings/storage-settings-form";
import { usesComposeStack } from "@/lib/utils";

export const metadata = { title: "Storage" };

export default async function AppStorageSettingsPage(
  props: PageProps<"/apps/[slug]/settings/storage">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // Derive the compose-stack gate from the SAVED source (the deploy source is
  // edited on its own page now, so there's no live source state to track here).
  const isComposeStack = usesComposeStack({
    source: project.source,
    compose: project.compose,
    repo: project.repo,
    dockerImage: project.dockerImage,
  });

  return (
    <section className="space-y-4">
      <SettingsSection icon={HardDrive} title="Storage" />
      <StorageSettingsForm
        appId={project.id}
        slug={project.slug}
        volumes={project.volumes ?? []}
        isComposeStack={isComposeStack}
      />
    </section>
  );
}
