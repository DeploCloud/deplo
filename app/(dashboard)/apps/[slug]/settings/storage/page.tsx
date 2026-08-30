// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { HardDrive } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { canMountHostVolumes } from "@/lib/membership";
import { hasAppCapability } from "@/lib/data/node-access";
import { containerWorkdir } from "@/lib/apps/volume-model";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { StorageSettingsForm } from "@/components/apps/settings/storage-settings-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
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
  // A Bind stays selectable without the grant - the editor says plainly that
  // saving one needs it, which beats hiding the option and the reason with it.
  const mayBind = await canMountHostVolumes();
  // A File entry's content is part of the app's configuration, so it rides the
  // same capability the rest of this page does.
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
          composeServices={composeServices}
          // The same heuristic the renderer falls back to, so the picker's
          // placeholder names the service a blank row will actually mount into.
          defaultComposeService={
            isComposeStack ? detectDefaultApp(project.compose)?.service : null
          }
          canMountHostVolumes={mayBind}
          canManageFiles={mayEditFiles}
          // "Path inside the app" is the field a non-expert cannot guess. For
          // anything deplo builds, the answer is a fact (the generated Dockerfile's
          // WORKDIR), so the editor states it instead of leaving a blank box.
          containerWorkdir={containerWorkdir(
            project.source,
            project.build.rootDirectory,
          )}
        />
      </CapabilityFieldset>
    </section>
  );
}
