import { readFile } from "node:fs/promises";
import path from "node:path";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import Link from "@/components/ui/link";
import { DeploSettingsPanel } from "@/components/settings/deplo-settings-panel/settings-tabs";
import type { Notice } from "@/components/settings/licenses-panel";
import { getInstanceSettings } from "@/lib/data/instance-settings/settings-store";
import { viewerIsInstanceOwner } from "@/lib/data/instance-owner";
import { listAllUsers } from "@/lib/data/members/instance-users";
import { listAllServers } from "@/lib/data/servers/roster";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isInstanceAdmin } from "@/lib/membership";
import { reportedAgentVersion } from "@/lib/version";
import { fleetAgentStatus } from "@/lib/data/servers/agent-rollout";
import { canaryReleasesEnabled } from "@/lib/data/updates";
import { securityUpdatesStatus } from "@/lib/data/security-updates/settings";

export const metadata = { title: "Settings · Deplo" };

// Written next to the build by scripts/third-party-notices.mjs.
async function readNotices(): Promise<Notice[]> {
  try {
    const file = path.join(process.cwd(), "public", "third-party-notices.json");
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

export default async function DeploSettingsPage() {
  if (!(await isInstanceAdmin())) notFound();
  const [
    settings,
    viewerIsOwner,
    users,
    servers,
    fleet,
    viewer,
    canary,
    security,
    notices,
  ] = await Promise.all([
    getInstanceSettings(),
    viewerIsInstanceOwner(),
    listAllUsers(),
    listAllServers(),
    fleetAgentStatus(),
    getCurrentUser(),
    canaryReleasesEnabled(),
    securityUpdatesStatus(),
    readNotices(),
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
        title="Deplo"
        description={
          <>
            <span className="font-mono">v{settings.version}</span>
            {settings.version.startsWith("0.") ? (
              <Badge variant="secondary" className="ml-2 align-middle">
                Beta
              </Badge>
            ) : null}
            <Link
              href="/settings/deplo?tab=about"
              className="ml-1.5 font-medium text-foreground underline underline-offset-2 hover:no-underline"
            >
              Learn more
            </Link>
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
        canary={canary}
        security={security}
        notices={notices}
      />
    </div>
  );
}
