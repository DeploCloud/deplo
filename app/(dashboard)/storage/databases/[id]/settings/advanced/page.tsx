import { notFound } from "next/navigation";
import Link from "next/link";
import { SlidersHorizontal, SquareTerminal } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { hasCapability } from "@/lib/membership";
import { listDatabaseCronJobs } from "@/lib/data/crons";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DatabaseImageSettings } from "@/components/storage/database-image-settings";
import { DatabaseConfigFiles } from "@/components/storage/database-config-files";
import { DB_DATA_DIRS } from "@/lib/deploy/database-compose";
import { DatabaseDanger } from "@/components/storage/database-danger";
import { CronSettingsForm } from "@/components/crons/cron-settings-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = { title: "Advanced" };

/**
 * Advanced: the powerful, less-everyday controls in one place — the Advanced
 * features card (the container Console and Cron jobs), expert image/command/
 * version overrides (applied on the next Redeploy) and the Danger Zone (rebuild
 * from scratch, delete with artifacts).
 */
export default async function DatabaseAdvancedSettingsPage(
  props: PageProps<"/storage/databases/[id]/settings/advanced">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();
  // A live shell into the container is infra-class — the console page itself gates on
  // it, so don't advertise a door the viewer can't open.
  const [canConsole, canCron] = await Promise.all([
    hasCapability("open_database_console"),
    hasCapability("manage_crons"),
  ]);
  const cron = canConsole && canCron ? await listDatabaseCronJobs(db.id) : null;

  return (
    <section className="space-y-6">
      <SettingsSection
        icon={SlidersHorizontal}
        title="Advanced"
        info="Turn on the advanced features, override the engine image or command, rebuild the database from scratch, or delete it."
      />

      {canConsole && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Advanced features</CardTitle>
            <CardDescription>
              Powerful extras, off the everyday path until you need them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
              <div className="min-w-56 flex-1 space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <SquareTerminal className="size-4 text-muted-foreground" />
                  Console
                </p>
                <p className="text-sm text-muted-foreground">
                  Open a terminal in the database&apos;s container and run{" "}
                  <span className="font-mono">psql</span>,{" "}
                  <span className="font-mono">redis-cli</span> or any other
                  client. No SSH needed.
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/storage/databases/${id}/console`}>
                  Open console
                </Link>
              </Button>
            </div>

            {cron && (
              <CronSettingsForm
                targetKind="database"
                targetId={db.id}
                enabled={cron.enabled}
                jobCount={cron.jobs.length}
              />
            )}
          </CardContent>
        </Card>
      )}

      <DatabaseImageSettings db={db} />
      <DatabaseConfigFiles db={db} dataDir={DB_DATA_DIRS[db.type]} />
      <DatabaseDanger db={db} />
    </section>
  );
}
