import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { listBasicAuthUsers } from "@/lib/data/basic-auth";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { BasicAuthManager } from "@/components/apps/basic-auth-manager";
import { PendingCreateProvider } from "@/components/shared/pending-create";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";

export const metadata = { title: "Access" };

export default async function AppAccessSettingsPage(
  props: PageProps<"/[team]/apps/[slug]/settings/access">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const basicAuthUsers = await listBasicAuthUsers(project.id);

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={ShieldCheck}
        title="Access"
        docs="domains.overview"
      />
      <CapabilityFieldset cap="manage_basic_auth">
        <PendingCreateProvider count={basicAuthUsers.length}>
          <BasicAuthManager appId={project.id} users={basicAuthUsers} />
        </PendingCreateProvider>
      </CapabilityFieldset>
    </section>
  );
}
