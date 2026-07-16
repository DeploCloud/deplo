import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { listServersForCurrentTeam } from "@/lib/data/servers";
import { canExposePorts } from "@/lib/membership";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseGeneralSettings } from "@/components/storage/database-general-settings";

export const metadata = { title: "General" };

export default async function DatabaseGeneralSettingsPage(
  props: PageProps<"/storage/databases/[id]/settings">,
) {
  const { id } = await props.params;
  const [db, servers, mayExposePorts] = await Promise.all([
    getDatabase(id),
    listServersForCurrentTeam(),
    canExposePorts(),
  ]);
  if (!db) notFound();

  // Only provisioned servers can host a database (provisioning routes through a
  // live agent), so those are the only move targets.
  const dbServers = servers
    .filter((s) => Boolean(s.agent?.certFingerprint))
    .map((s) => ({ id: s.id, name: s.name }));

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Settings2}
        title="General"
        info="Public exposure, the server this database runs on, and password rotation."
      />
      <DatabaseGeneralSettings
        db={db}
        servers={dbServers}
        canExposePorts={mayExposePorts}
      />
    </section>
  );
}
