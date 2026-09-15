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
import { agentUpdateAvailable, reportedAgentVersion } from "@/lib/version";
import { resolveExpectedAgentVersion } from "@/lib/agent/release";

export const metadata = { title: "Settings · Deplo" };

export default async function DeploSettingsPage() {
  if (!(await isInstanceAdmin())) notFound();
  const [
    settings,
    viewerIsOwner,
    users,
    servers,
    expectedAgentVersion,
    viewer,
  ] = await Promise.all([
    getInstanceSettings(),
    viewerIsInstanceOwner(),
    listAllUsers(),
    listAllServers(),
    resolveExpectedAgentVersion(),
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

  const fleetHosts = servers.filter((s) => !s.importOnly);
  const fleet = {
    total: fleetHosts.length,
    outdated: fleetHosts.filter((s) =>
      agentUpdateAvailable(reportedAgentVersion(s), expectedAgentVersion),
    ).length,
    expected: expectedAgentVersion,
  };
  const hosts = fleetHosts.map((s) => ({
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
