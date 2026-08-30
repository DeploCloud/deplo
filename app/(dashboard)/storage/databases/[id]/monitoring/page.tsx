// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
import { getDatabaseMetricsHistory } from "@/lib/data/container-metrics";
import { listServers } from "@/lib/data/servers";
import { isInstanceAdmin } from "@/lib/membership";
import { serverLabel } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { SettingsShortcut } from "@/components/shared/settings-shortcut";
import { ContainerMonitoringDashboard } from "@/components/monitoring/container-monitoring-dashboard";
import { HostChip } from "@/components/monitoring/host-chip";

export const metadata = { title: "Monitoring" };

export default async function DatabaseMonitoringPage(
  props: PageProps<"/storage/databases/[id]/monitoring">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  // The buffered window, so the charts render full on the first paint. Nothing
  // gates it: the telemetry stream carries this database's container regardless.
  const [initialHistory, servers, canManageServers] = await Promise.all([
    getDatabaseMetricsHistory(db.id),
    listServers(),
    isInstanceAdmin(),
  ]);
  const host = servers.find((s) => s.id === db.serverId);

  return (
    <div className="space-y-5">
      <PageHeader
        level="section"
        docs="monitoring.overview"
        title="Monitoring"
        description="Real-time CPU, memory, network and disk I/O for this database's container."
        actions={
          <div className="flex items-center gap-2">
            {host && (
              <HostChip
                serverId={host.id}
                serverName={serverLabel(host)}
                canManage={canManageServers}
              />
            )}
            <SettingsShortcut
              href={`/storage/databases/${db.id}/settings/resources`}
              label="Resource limits"
            />
          </div>
        }
      />
      <ContainerMonitoringDashboard
        kind="database"
        id={db.id}
        initialHistory={initialHistory}
        resources={db.resources}
      />
    </div>
  );
}
