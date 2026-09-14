import { notFound } from "next/navigation";
import { Network } from "lucide-react";
import { getDatabase } from "@/lib/data/databases/rows";
import { listServersForCurrentTeam } from "@/lib/data/servers/roster";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { canExposePorts, hasCapability } from "@/lib/membership";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseConnectionSettings } from "@/components/storage/database-connection-settings";

export const metadata = { title: "Connection" };

export default async function DatabaseConnectionSettingsPage(
  props: PageProps<"/[team]/storage/databases/[id]/settings/connection">,
) {
  const { id } = await props.params;
  const [db, servers, mayExposePorts, canConfigure] = await Promise.all([
    getDatabase(id),
    listServersForCurrentTeam(),
    canExposePorts(),
    hasCapability("configure_databases"),
  ]);
  if (!db) notFound();

  // Only a provisioned server can host a database: a storage-only host runs nothing, a migration source is not our machine.
  const selfAddrs = deploHostSelfAddresses();
  const dbServers = servers
    .filter(
      (s) =>
        Boolean(s.agent?.certFingerprint) && !s.storageOnly && !s.importOnly,
    )
    .map((s) => ({
      id: s.id,
      name: s.name,
      isDeploHost: isDeploHostServer(s, selfAddrs),
    }));

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
