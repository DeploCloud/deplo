import { notFound } from "next/navigation";
import { Cpu } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { ResourceLimitsForm } from "@/components/apps/settings/resource-limits-form";

export const metadata = { title: "Resources" };

/**
 * Per-database resource caps — the same form apps use, saving through
 * updateDatabaseResources. Applied on the next redeploy/reroute (the row is
 * truth), so the copy says "redeploy", not "deploy".
 */
export default async function DatabaseResourcesSettingsPage(
  props: PageProps<"/storage/databases/[id]/settings/resources">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Cpu}
        title="Resources"
        info="Cap how much RAM, CPU, disk and processes this database may use. Applied on the next redeploy."
      />
      {/* MySQL/MariaDB InnoDB needs headroom — a note so a too-small memory cap
          doesn't OOM-loop silently. */}
      {(db.type === "mysql" || db.type === "mariadb") && (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {db.type === "mysql" ? "MySQL" : "MariaDB"} generally needs at least{" "}
          <strong className="font-medium text-foreground">512 MB</strong> of
          memory — a smaller limit can send InnoDB into a restart loop.
        </p>
      )}
      <ResourceLimitsForm
        appId={db.id}
        resources={db.resources}
        isComposeStack={false}
        mutationName="updateDatabaseResources"
        savedMessage="Resource limits saved — Redeploy to apply"
      />
    </section>
  );
}
