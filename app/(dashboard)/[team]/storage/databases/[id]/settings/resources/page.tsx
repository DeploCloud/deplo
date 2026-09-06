import { notFound } from "next/navigation";
import { Cpu } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { getDatabaseMetricsHistory } from "@/lib/data/container-metrics";
import { listServers } from "@/lib/data/servers";
import { canMountHostVolumes, hasCapability } from "@/lib/membership";
import { serverLabel } from "@/lib/utils";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { ResourceLimitsForm } from "@/components/apps/settings/resource-limits-form";

export const metadata = { title: "Resources" };

/** Per-database caps - the app form, saving through updateDatabaseResources. */
export default async function DatabaseResourcesSettingsPage(
  props: PageProps<"/[team]/storage/databases/[id]/settings/resources">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  const [servers, canViewMetrics, canRedeploy, canProtectFromOom] =
    await Promise.all([
      listServers(),
      hasCapability("view_metrics"),
      hasCapability("control_databases"),
      canMountHostVolumes(),
    ]);
  const server = servers.find((s) => s.id === db.serverId);
  const usage = canViewMetrics ? await getDatabaseMetricsHistory(db.id) : null;

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Cpu}
        title="Resources"
        docs="resources.overview"
        info="Cap how much RAM, CPU, disk and processes this database may use. Applied on the next redeploy."
      />
      {/* InnoDB needs headroom: a too-small cap is a silent restart loop. */}
      {(db.type === "mysql" || db.type === "mariadb") && (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {db.type === "mysql" ? "MySQL" : "MariaDB"} generally needs at least{" "}
          <strong className="font-medium text-foreground">512 MB</strong> of
          memory - a smaller limit can send InnoDB into a restart loop.
        </p>
      )}
      <ResourceLimitsForm
        kind="database"
        id={db.id}
        resources={db.resources}
        host={
          server
            ? {
                name: serverLabel(server),
                memoryMb: server.memoryMb,
                cpuCores: server.cpuCores,
              }
            : null
        }
        usage={usage}
        canRedeploy={canRedeploy}
        canProtectFromOom={canProtectFromOom}
      />
    </section>
  );
}
