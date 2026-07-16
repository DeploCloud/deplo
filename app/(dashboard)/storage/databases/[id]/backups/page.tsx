import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { hasCapability } from "@/lib/membership";
import { listBackups } from "@/lib/data/backups";
import { listS3 } from "@/lib/data/s3";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { DatabaseBackups } from "@/components/storage/database-backups";

export const metadata = { title: "Backups" };

export default async function DatabaseBackupsPage(
  props: PageProps<"/storage/databases/[id]/backups">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  // Backup/restore are infra ops (overwrite-in-place); gate on manage_infra. The
  // tab is hidden without it, but guard the page too against a direct link.
  if (!(await hasCapability("manage_infra"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to backups"
        description="You don't have permission to manage this database's backups. Ask a team admin for the “Manage infrastructure” permission."
      />
    );
  }

  const [allBackups, destinations] = await Promise.all([listBackups(), listS3()]);
  // Only this database's schedules — listBackups returns the whole team's.
  const schedules = allBackups.filter(
    (b) => b.targetKind === "database" && b.databaseId === db.id,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Backups"
        description="Scheduled dumps of this database to an S3 destination, and restore."
      />
      <DatabaseBackups
        database={{ id: db.id, name: db.name }}
        schedules={schedules}
        destinations={destinations.map((d) => ({ id: d.id, name: d.name }))}
      />
    </div>
  );
}
