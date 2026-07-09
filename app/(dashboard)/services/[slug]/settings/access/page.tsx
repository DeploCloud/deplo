import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getServiceBySlug } from "@/lib/data/services";
import { listBasicAuthUsers } from "@/lib/data/basic-auth";
import { SettingsSection } from "@/components/services/settings/settings-shared";
import { BasicAuthManager } from "@/components/services/basic-auth-manager";

export const metadata = { title: "Access" };

export default async function ServiceAccessSettingsPage(
  props: PageProps<"/services/[slug]/settings/access">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  // listBasicAuthUsers requires manage_domains and THROWS without it — the same
  // call the combined settings page made. The sidebar only surfaces this Access
  // entry to manage_domains holders (see serviceSettingsNav), so a viewer without
  // it never reaches here through the UI; a direct hit gets the capability error.
  const basicAuthUsers = await listBasicAuthUsers(project.id);

  return (
    <section className="space-y-4">
      <SettingsSection icon={ShieldCheck} title="Access" />
      <BasicAuthManager serviceId={project.id} users={basicAuthUsers} />
    </section>
  );
}
