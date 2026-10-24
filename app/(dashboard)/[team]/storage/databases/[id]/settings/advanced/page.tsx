import { notFound } from "next/navigation";
import Link from "@/components/ui/link";
import { SlidersHorizontal, Sparkles, SquareTerminal } from "lucide-react";
import { getDatabase } from "@/lib/data/databases/rows";
import { hasCapability } from "@/lib/membership";
import { listDatabaseCronJobs } from "@/lib/data/crons/listing";
import {
  FeatureRow,
  RowsCard,
  SettingsSection,
} from "@/components/apps/settings/settings-shared";
import { DatabaseImageSettings } from "@/components/storage/database-image-settings";
import { DatabaseConfigFiles } from "@/components/storage/database-config-files";
import { DB_DATA_DIRS } from "@/lib/deploy/database-compose";
import { DatabaseDanger } from "@/components/storage/database-danger";
import { CronSettingsForm } from "@/components/crons/cron-settings-form";
import { RestartLoopForm } from "@/components/apps/settings/restart-loop-form";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Advanced" };

export default async function DatabaseAdvancedSettingsPage(
  props: PageProps<"/[team]/storage/databases/[id]/settings/advanced">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();
  const [canConsole, canCron, canMove] = await Promise.all([
    hasCapability("open_database_console"),
    hasCapability("manage_crons"),
    hasCapability("move_databases"),
  ]);
  const cron = canConsole && canCron ? await listDatabaseCronJobs(db.id) : null;

  return (
    <section className="space-y-6">
      <SettingsSection
        icon={SlidersHorizontal}
        title="Advanced"
        docs="databases.settings"
        info="Turn on the advanced features, override the engine image or command, rebuild the database from scratch, or delete it."
      />

      <RowsCard
        icon={Sparkles}
        title="Features"
        info="Powerful extras, off the everyday path until you need them."
        docs="databases.settings"
      >
        {canConsole && (
          <FeatureRow
            icon={SquareTerminal}
            title="Console"
            description={
              <>
                Open a terminal in the database&apos;s container and run{" "}
                <span className="font-mono">psql</span>,{" "}
                <span className="font-mono">redis-cli</span> or any other
                client. No SSH needed.
              </>
            }
            control={
              <Button asChild size="sm" variant="outline">
                <Link href={`/storage/databases/${id}/console`}>
                  Open console
                </Link>
              </Button>
            }
          />
        )}

        {cron && (
          <CronSettingsForm
            targetKind="database"
            targetId={db.id}
            enabled={cron.enabled}
            jobCount={cron.jobs.length}
          />
        )}

        <RestartLoopForm
          targetKind="database"
          targetId={db.id}
          enabled={db.restartLoopGuard}
        />
      </RowsCard>

      <DatabaseImageSettings db={db} />
      <DatabaseConfigFiles db={db} dataDir={DB_DATA_DIRS[db.type]} />
      <DatabaseDanger db={db} canMove={canMove} />
    </section>
  );
}
