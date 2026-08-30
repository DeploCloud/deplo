// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { listServers } from "@/lib/data/servers";
import {
  getFleetMetrics,
  getServerMetricsHistory,
} from "@/lib/data/monitoring";
import { Lock } from "lucide-react";
import { isInstanceAdmin, reachesWholeTeam } from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";
import { MonitoringDashboard } from "./monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default async function MonitoringPage() {
  // Cheap last-known metrics so the page renders instantly. Saying so beats handing
  // them the error boundary the team-wide read would throw.
  if (!(await reachesWholeTeam()))
    return (
      <EmptyState
        icon={Lock}
        title="Outside your access"
        docs="roles.floorCeiling"
        description="Your role reaches part of this team. The hosts belong to the whole of it."
      />
    );

  const [servers, fleet, canManageServers] = await Promise.all([
    listServers(),
    getFleetMetrics(),
    // The server pages are instance-admin only; without it the link would 404.
    isInstanceAdmin(),
  ]);

  // Seed the FIRST server's real buffered window, the way the app tab does. This
  // replaced a synthetic snapshot built from three columns nothing writes, which
  // rendered an online host as 0% CPU, 0% memory and 0 containers.
  const shown = servers.filter((s) => !s.importOnly);
  const initialHistory = shown[0]
    ? await getServerMetricsHistory(shown[0].id)
    : [];

  return (
    <MonitoringDashboard
      // Migration sources are not the fleet: no telemetry stream is opened to
      // them, so a row here could only ever read "No data".
      servers={shown.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        ip: s.ip,
        dockerVersion: s.dockerVersion,
      }))}
      initialHistory={initialHistory}
      initialFleet={fleet}
      canManageServers={canManageServers}
    />
  );
}
