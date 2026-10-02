import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { getDatabase } from "@/lib/data/databases/rows";
import { listServersForCurrentTeam } from "@/lib/data/servers/roster";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { hasCapability } from "@/lib/membership";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseGeneralSettings } from "@/components/storage/database-general-settings";
import { DatabaseServerCard } from "@/components/shared/server-move-card";

export const metadata = { title: "General" };

export default async function DatabaseGeneralSettingsPage(
  props: PageProps<"/[team]/storage/databases/[id]/settings">,
) {
  const { id } = await props.params;
  const [db, servers, canConfigure] = await Promise.all([
    getDatabase(id),
    listServersForCurrentTeam(),
    hasCapability("configure_databases"),
  ]);
  if (!db) notFound();

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
        icon={Settings2}
        title="General"
        docs="databases.settings"
      />
      <DatabaseGeneralSettings db={db} />
      <DatabaseServerCard
        db={db}
        servers={dbServers}
        disabled={!canConfigure}
      />
    </section>
  );
}
