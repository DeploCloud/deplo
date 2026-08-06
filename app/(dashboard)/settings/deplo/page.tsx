import Link from "next/link";
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
      {/* Version and host are read-only facts about this instance, so they ride
          the header instead of taking a card of their own: a settings page should
          open on what can be changed. */}
      <PageHeader
        title="Deplo"
        description={
          <>
            <span className="font-mono">v{settings.version}</span>
            {" · "}
            {settings.deploHostId ? (
              <>
                runs on{" "}
                <Link
                  href={`/settings/servers/${settings.deploHostId}`}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  {settings.deploHostName}
                </Link>
              </>
            ) : (
              "runs on a server not added here yet"
            )}
          </>
        }
      />
      <DeploSettingsPanel settings={settings} />
    </div>
  );
}
