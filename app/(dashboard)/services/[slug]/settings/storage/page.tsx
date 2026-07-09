import { notFound } from "next/navigation";
import { HardDrive } from "lucide-react";
import { getServiceBySlug } from "@/lib/data/services";
import { SettingsSection } from "@/components/services/settings/settings-shared";
import { StorageSettingsForm } from "@/components/services/settings/storage-settings-form";
import { usesComposeStack } from "@/lib/utils";

export const metadata = { title: "Storage" };

export default async function ServiceStorageSettingsPage(
  props: PageProps<"/services/[slug]/settings/storage">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
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
        serviceId={project.id}
        slug={project.slug}
        volumes={project.volumes ?? []}
        isComposeStack={isComposeStack}
      />
    </section>
  );
}
