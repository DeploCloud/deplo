// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { Network } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { listServersForCurrentTeam } from "@/lib/data/servers";
import { canExposePorts, hasCapability } from "@/lib/membership";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseConnectionSettings } from "@/components/storage/database-connection-settings";

export const metadata = { title: "Connection" };

/**
 * Connection: how clients reach this database and authenticate - public exposure
 * and its host port, the server it runs on, and password rotation.
 */
export default async function DatabaseConnectionSettingsPage(
  props: PageProps<"/storage/databases/[id]/settings/connection">,
) {
  const { id } = await props.params;
  const [db, servers, mayExposePorts, canConfigure] = await Promise.all([
    getDatabase(id),
    listServersForCurrentTeam(),
    canExposePorts(),
    hasCapability("configure_databases"),
  ]);
  if (!db) notFound();

  // Only provisioned servers can host a database (provisioning routes through a
  // live agent), so those are the only move targets, and neither a storage-only
  // host (runs nothing) nor a migration source (not our machine) is ever one.
  const dbServers = servers
    .filter(
      (s) =>
        Boolean(s.agent?.certFingerprint) && !s.storageOnly && !s.importOnly,
    )
    .map((s) => ({ id: s.id, name: s.name }));

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Network}
        title="Connection"
        docs="databases.connect"
        info="Public exposure, the server this database runs on, and password rotation."
      />
      <DatabaseConnectionSettings
        db={db}
        servers={dbServers}
        canExposePorts={mayExposePorts}
        canConfigure={canConfigure}
      />
    </section>
  );
}
