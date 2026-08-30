// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { DeploSettingsPanel } from "@/components/settings/deplo-settings-panel";
import { getInstanceSettings } from "@/lib/data/instance-settings";
import { viewerIsInstanceOwner } from "@/lib/data/instance-owner";
import { listAllUsers } from "@/lib/data/members";
import { listAllServers } from "@/lib/data/servers";
import { isInstanceAdmin } from "@/lib/membership";
import {
  agentUpdateAvailable,
  reportedAgentVersion,
  resolveExpectedAgentVersion,
} from "@/lib/version";

export const metadata = { title: "Settings · Deplo" };

/**
 * Settings → Deplo: the instance itself.
 */
export default async function DeploSettingsPage() {
  if (!(await isInstanceAdmin())) notFound();
  const [settings, viewerIsOwner, users, servers, expectedAgentVersion] =
    await Promise.all([
      getInstanceSettings(),
      viewerIsInstanceOwner(),
      listAllUsers(),
      listAllServers(),
      resolveExpectedAgentVersion(),
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

  // A migration source hosts nothing and takes its own agent off when it is done
  // (ADR-0025), so counting it would report a host nobody has to keep current.
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
            {/* Derived from the version, not a flag: the badge disappears on its
                own the day 1.0.0 ships. */}
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
        ownerCandidates={ownerCandidates}
        fleet={fleet}
        hosts={hosts}
      />
    </div>
  );
}
