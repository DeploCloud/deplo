import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { getDatabaseConsoleInfo } from "@/lib/data/database-console";
import { hasCapability } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ConsoleWarningGate } from "@/components/apps/console-warning-gate";
import { DatabaseConsole } from "@/components/storage/database-console";

export const metadata = { title: "Console" };

export default async function DatabaseConsolePage(
  props: PageProps<"/storage/databases/[id]/console">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  // A live shell into the database container is an infra-class operation — gate
  // on manage_infra (the tab is hidden without it; guard the page too).
  if (!(await hasCapability("manage_infra"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to the console"
        description="You don't have permission to open a console into this database. Ask a team admin for the “Manage infrastructure” permission."
      />
    );
  }

  const info = await getDatabaseConsoleInfo(id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Console"
        description="Run commands in the database's container (docker exec)."
      />
      {/* One-time "know what you're doing" warning, keyed by the container so a
          per-app ack doesn't unlock a database and vice versa. */}
      <ConsoleWarningGate slug={`db-${db.id}`}>
        <DatabaseConsole
          id={db.id}
          status={db.status}
          containerName={info?.containerName ?? db.host}
          image={info?.image ?? ""}
        />
      </ConsoleWarningGate>
    </div>
  );
}
