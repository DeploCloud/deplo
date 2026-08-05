import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shared/page-header";
import { DeploSettingsPanel } from "@/components/settings/deplo-settings-panel";
import { getInstanceSettings } from "@/lib/data/instance-settings";
import { isInstanceAdmin } from "@/lib/membership";

export const metadata = { title: "Settings · Deplo" };

/**
 * Settings → Deplo: the instance itself.
 *
 * Everything on it is one setting for the whole instance and applies across
 * hosts, so it is instance-admin gated and 404s (like its sibling
 * /settings/servers) rather than advertising its own existence to someone who
 * cannot use it, the gate is BEFORE the read, which throws for the same reason.
 *
 * The render never dials a server: the panel address comes from the database and
 * the certificate accounts are fetched client-side once the page is on screen,
 * so a sick host cannot make the settings page as slow as itself.
 */
export default async function DeploSettingsPage() {
  if (!(await isInstanceAdmin())) notFound();
  const settings = await getInstanceSettings();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deplo"
        description="How this instance addresses itself, and where its certificates are registered."
      />
      <DeploSettingsPanel settings={settings} />
    </div>
  );
}
