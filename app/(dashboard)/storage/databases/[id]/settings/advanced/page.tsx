import { notFound } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseImageSettings } from "@/components/storage/database-image-settings";
import { DatabaseDanger } from "@/components/storage/database-danger";

export const metadata = { title: "Advanced" };

/**
 * Advanced: expert image/command/version overrides (applied on the next
 * Redeploy) and the Danger Zone (rebuild from scratch, delete with artifacts).
 */
export default async function DatabaseAdvancedSettingsPage(
  props: PageProps<"/storage/databases/[id]/settings/advanced">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  return (
    <section className="space-y-6">
      <SettingsSection
        icon={SlidersHorizontal}
        title="Advanced"
        info="Override the engine image or command, rebuild the database from scratch, or delete it."
      />
      <DatabaseImageSettings db={db} />
      <DatabaseDanger db={db} />
    </section>
  );
}
