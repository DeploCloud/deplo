import { notFound } from "next/navigation";
import { Lock } from "lucide-react";

import { getDatabase } from "@/lib/data/databases";
import { hasCapability } from "@/lib/membership";
import { listDatabaseCronJobs } from "@/lib/data/crons";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { CronJobsList } from "@/components/crons/cron-jobs-list";

export const metadata = { title: "Cron jobs" };

export default async function DatabaseCronJobsPage(
  props: PageProps<"/storage/databases/[id]/cron-jobs">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  // TWO capabilities, and the second is not belt-and-braces: `manage_crons` is
  // seeded from EITHER console capability, so app-console access alone must not
  // reach inside a database. The data layer enforces the same pair.
  const [canCron, canConsole] = await Promise.all([
    hasCapability("manage_crons"),
    hasCapability("open_database_console"),
  ]);
  if (!canCron || !canConsole) {
    return (
      <EmptyState
        icon={Lock}
        title="You cannot manage cron jobs here"
        description={`A cron job runs commands inside the database container, so it needs both "Manage cron jobs" and "Open a database's console". Ask a team admin.`}
      />
    );
  }

  const view = await listDatabaseCronJobs(db.id);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Cron jobs"
        description="Commands run inside this database's container on a schedule."
      />
      <CronJobsList
        targetKind="database"
        targetId={db.id}
        enabled={view.enabled}
        jobs={view.jobs}
        services={view.services}
        canManage
        settingsHref={`/storage/databases/${db.id}/settings/cron-jobs`}
      />
    </div>
  );
}
