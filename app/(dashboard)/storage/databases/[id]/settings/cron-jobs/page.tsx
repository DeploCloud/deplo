import { notFound } from "next/navigation";
import { Lock, Timer } from "lucide-react";

import { getDatabase } from "@/lib/data/databases";
import { hasCapability } from "@/lib/membership";
import { listDatabaseCronJobs } from "@/lib/data/crons";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { EmptyState } from "@/components/shared/empty-state";
import { CronSettingsForm } from "@/components/crons/cron-settings-form";

export const metadata = { title: "Cron jobs" };

/** The database twin of the app's Settings → Cron jobs: the opt-in switch. */
export default async function DatabaseCronSettingsPage(
  props: PageProps<"/storage/databases/[id]/settings/cron-jobs">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

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
    <section className="space-y-4">
      <SettingsSection
        icon={Timer}
        title="Cron jobs"
        info="Run a command inside this database's container on a schedule, with its own timezone, timeout and retries."
      />
      <CronSettingsForm
        targetKind="database"
        targetId={db.id}
        enabled={view.enabled}
        jobCount={view.jobs.length}
      />
    </section>
  );
}
