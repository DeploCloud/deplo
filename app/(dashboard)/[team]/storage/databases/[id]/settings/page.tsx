import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { getDatabase } from "@/lib/data/databases/rows";
import { getFailoverPreview } from "@/lib/data/databases/failover";
import { databaseFailoverReach } from "@/lib/data/clusters/architectures";
import {
  listPlacementChoices,
  placementOption,
} from "@/lib/data/clusters/choices";
import { getCluster } from "@/lib/data/clusters/roster";
import { redeployArchs } from "@/lib/data/clusters/architectures";
import { listClusterServerChoices } from "@/lib/data/clusters/member-choice";
import {
  getServerById,
  listServersForCurrentTeam,
} from "@/lib/data/servers/roster";
import { hasCapability } from "@/lib/membership";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseGeneralSettings } from "@/components/storage/database-general-settings";
import { DatabaseServerCard } from "@/components/shared/server-move-card";

export const metadata = { title: "General" };

export default async function DatabaseGeneralSettingsPage(
  props: PageProps<"/[team]/storage/databases/[id]/settings">,
) {
  const { id } = await props.params;
  const [db, servers, choices, canConfigure, failover] = await Promise.all([
    getDatabase(id),
    listServersForCurrentTeam(),
    listPlacementChoices(),
    hasCapability("configure_databases"),
    getFailoverPreview(id),
  ]);
  if (!db) notFound();

  const [cluster, member, reach, clusterChoices] = await Promise.all([
    db.clusterId ? getCluster(db.clusterId) : null,
    db.clusterId ? getServerById(db.serverId) : null,
    databaseFailoverReach(db),
    redeployArchs("database", db.id).then((archs) =>
      listClusterServerChoices({
        id: db.id,
        name: db.name,
        limitMb: db.resources?.memoryMb ?? 0,
        archs,
        clusterId: db.clusterId,
        serverId: db.serverId,
      }),
    ),
  ]);
  const provisioned = new Set(
    servers.filter((s) => s.agent?.certFingerprint).map((s) => s.id),
  );
  const dbServers = choices
    .filter((c) => c.kind === "cluster" || provisioned.has(c.id))
    .map(placementOption);

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Settings2}
        title="General"
        docs="databases.settings"
      />
      <DatabaseGeneralSettings db={db} />
      <DatabaseServerCard
        db={db}
        servers={dbServers}
        clusters={clusterChoices}
        disabled={!canConfigure}
        failover={failover}
        cluster={
          cluster
            ? {
                id: cluster.id,
                name: cluster.name,
                serverName: member?.name ?? "a server in it",
                reach,
              }
            : null
        }
      />
    </section>
  );
}
