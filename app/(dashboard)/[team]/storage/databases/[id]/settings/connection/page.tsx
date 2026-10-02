import { notFound } from "next/navigation";
import { Network } from "lucide-react";
import { getDatabase } from "@/lib/data/databases/rows";
import { canExposePorts, hasCapability } from "@/lib/membership";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseConnectionSettings } from "@/components/storage/database-connection-settings";

export const metadata = { title: "Connection" };

export default async function DatabaseConnectionSettingsPage(
  props: PageProps<"/[team]/storage/databases/[id]/settings/connection">,
) {
  const { id } = await props.params;
  const [db, mayExposePorts, canConfigure] = await Promise.all([
    getDatabase(id),
    canExposePorts(),
    hasCapability("configure_databases"),
  ]);
  if (!db) notFound();

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Network}
        title="Connection"
        docs="databases.connect"
        info="Public exposure and password rotation."
      />
      <DatabaseConnectionSettings
        db={db}
        canExposePorts={mayExposePorts}
        canConfigure={canConfigure}
      />
    </section>
  );
}
