import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { DeploSettingsPanel } from "@/components/settings/deplo-settings-panel";
import { getInstanceSettings } from "@/lib/data/instance-settings";
import { viewerIsInstanceOwner } from "@/lib/data/instance-owner";
import { listAllUsers } from "@/lib/data/members";
import { isInstanceAdmin } from "@/lib/membership";

export const metadata = { title: "Settings · Deplo" };

/**
 * Settings → Deplo: the instance itself.
 */
export default async function DeploSettingsPage() {
  if (!(await isInstanceAdmin())) notFound();
  const [settings, viewerIsOwner, users] = await Promise.all([
    getInstanceSettings(),
    viewerIsInstanceOwner(),
    listAllUsers(),
  ]);

  // Who the crown could go to, narrowed to exactly what the server would accept: an
  // active instance admin who isn't already the owner.
  const ownerCandidates = users
    .filter((u) => u.isInstanceAdmin && !u.isInstanceOwner && !u.suspended)
    .map((u) => ({
      userId: u.userId,
      username: u.username,
      avatarColor: u.avatarColor,
      avatarUrl: u.avatarUrl,
    }));

  return (
    <div className="space-y-6">
      {/**
       * Version and host are read-only facts about this instance, so they ride the header
       * instead of taking a card of their own: a settings page should open on what can be
       * changed.
       */}
      <PageHeader
        title="Deplo"
        description={
          <>
            <span className="font-mono">v{settings.version}</span>
            {/* Derived from the version, not a flag: the badge disappears on its
                own the day 1.0.0 ships, so there is no line to remember to delete
                and no env var left switched on in production. */}
            {settings.version.startsWith("0.") ? (
              <Badge variant="secondary" className="ml-2 align-middle">
                Beta
              </Badge>
            ) : null}
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
      <DeploSettingsPanel
        settings={settings}
        viewerIsOwner={viewerIsOwner}
        ownerCandidates={ownerCandidates}
      />
    </div>
  );
}
