import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { DeploSettingsPanel } from "@/components/settings/deplo-settings-panel/settings-tabs";
import { getInstanceSettings } from "@/lib/data/instance-settings/settings-store";
import { viewerIsInstanceOwner } from "@/lib/data/instance-owner";
import { listAllUsers } from "@/lib/data/members/instance-users";
import { listAllServers } from "@/lib/data/servers/roster";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isInstanceAdmin } from "@/lib/membership";
import { reportedAgentVersion } from "@/lib/version";
import { fleetAgentStatus } from "@/lib/data/servers/agent-rollout";

export const metadata = { title: "Settings · Deplo" };

export default async function DeploSettingsPage() {
  if (!(await isInstanceAdmin())) notFound();
  const [settings, viewerIsOwner, users, servers, fleet, viewer] =
    await Promise.all([
      getInstanceSettings(),
      viewerIsInstanceOwner(),
      listAllUsers(),
      listAllServers(),
      fleetAgentStatus(),
      getCurrentUser(),
    ]);

  const ownerCandidates = users
    .filter((u) => u.isInstanceAdmin && !u.isInstanceOwner && !u.suspended)
    .map((u) => ({
      userId: u.userId,
      username: u.username,
      avatarColor: u.avatarColor,
      avatarUrl: u.avatarUrl,
    }));

  const hosts = servers
    .filter((s) => !s.importOnly)
    .map((s) => ({
      name: s.name,
      agentVersion: reportedAgentVersion(s),
      dockerVersion: s.dockerVersion,
      hostArch: s.hostArch,
    }));

  return (
    <div className="space-y-3">
      <PageHeader
        docs="panel.address"
        title="Deplo"
        description={
          <>
            <span className="font-mono">v{settings.version}</span>
            {settings.version.startsWith("0.") ? (
              <Badge variant="secondary" className="ml-2 align-middle">
                Beta
              </Badge>
            ) : null}
          </>
        }
      />
      <DeploSettingsPanel
        settings={settings}
        viewerIsOwner={viewerIsOwner}
        viewerTwoFactorEnabled={viewer?.twoFactorEnabled ?? false}
        ownerCandidates={ownerCandidates}
        fleet={fleet}
        hosts={hosts}
      />
    </div>
  );
}
