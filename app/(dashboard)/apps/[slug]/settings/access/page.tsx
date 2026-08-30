// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { listBasicAuthUsers } from "@/lib/data/basic-auth";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { BasicAuthManager } from "@/components/apps/basic-auth-manager";
import { PendingCreateProvider } from "@/components/shared/pending-create";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";

export const metadata = { title: "Access" };

export default async function AppAccessSettingsPage(
  props: PageProps<"/apps/[slug]/settings/access">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // Lists nothing without `manage_basic_auth` on this app - the sidebar only
  // surfaces the entry to holders, and a direct hit lands on the read-only
  // empty state rather than an error.
  const basicAuthUsers = await listBasicAuthUsers(project.id);

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={ShieldCheck}
        title="Access"
        docs="domains.overview"
      />
      {/* Adding a credential closes its dialog immediately and shows the new
          card pulsing in the grid while the routing is applied - the provider
          holds that placeholder, so it has to sit above the manager. */}
      <CapabilityFieldset cap="manage_basic_auth">
        <PendingCreateProvider count={basicAuthUsers.length}>
          <BasicAuthManager appId={project.id} users={basicAuthUsers} />
        </PendingCreateProvider>
      </CapabilityFieldset>
    </section>
  );
}
