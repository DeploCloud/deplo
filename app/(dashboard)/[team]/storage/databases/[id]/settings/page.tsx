import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { getDatabase } from "@/lib/data/databases/rows";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseGeneralSettings } from "@/components/storage/database-general-settings";

export const metadata = { title: "General" };

export default async function DatabaseGeneralSettingsPage(
  props: PageProps<"/[team]/storage/databases/[id]/settings">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Settings2}
        title="General"
        docs="databases.settings"
      />
      <DatabaseGeneralSettings db={db} />
    </section>
  );
}
