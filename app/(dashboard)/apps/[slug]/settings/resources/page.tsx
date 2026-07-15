import { notFound } from "next/navigation";
import { Cpu } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { ResourceLimitsForm } from "@/components/apps/settings/resource-limits-form";
import { usesComposeStack } from "@/lib/utils";

export const metadata = { title: "Resources" };

/**
 * Resources settings: per-app caps on RAM / CPU / processes / disk. Baked into
 * the rendered compose at deploy time, so a runaway app can't starve its
 * neighbours on a shared host — no Docker knowledge required.
 */
export default async function AppResourcesSettingsPage(
  props: PageProps<"/apps/[slug]/settings/resources">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // A compose stack still gets limits, but per service — the form notes it.
  const isComposeStack = usesComposeStack({
    source: project.source,
    compose: project.compose,
    repo: project.repo,
    dockerImage: project.dockerImage,
  });

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Cpu}
        title="Resources"
        info="Cap how much RAM, CPU, disk and processes this app may use. Applied on the next deploy."
      />
      <ResourceLimitsForm
        appId={project.id}
        resources={project.resources}
        isComposeStack={isComposeStack}
      />
    </section>
  );
}
