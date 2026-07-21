import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { listBasicAuthUsers } from "@/lib/data/basic-auth";
import { listDomains } from "@/lib/data/domains";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { BasicAuthManager } from "@/components/apps/basic-auth-manager";

export const metadata = { title: "Access" };

export default async function AppAccessSettingsPage(
  props: PageProps<"/apps/[slug]/settings/access">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // listBasicAuthUsers requires manage_domains and THROWS without it — the same
  // call the combined settings page made. The sidebar only surfaces this Access
  // entry to manage_domains holders (see appSettingsNav), so a viewer without
  // it never reaches here through the UI; a direct hit gets the capability error.
  //
  // The domains ride along because they are what a credential actually gates:
  // the page states which hostnames sit behind the login — and says so when
  // there are none yet — instead of leaving that to be guessed. `listDomains`
  // already returns them team-scoped and primary-first.
  const [basicAuthUsers, domains] = await Promise.all([
    listBasicAuthUsers(project.id),
    listDomains(project.id),
  ]);

  return (
    <section className="space-y-4">
      <SettingsSection icon={ShieldCheck} title="Access" />
      <BasicAuthManager
        appId={project.id}
        users={basicAuthUsers}
        domains={domains.map((d) => d.name)}
      />
    </section>
  );
}
