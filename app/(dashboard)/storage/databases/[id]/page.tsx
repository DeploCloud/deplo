import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
import { getServerById } from "@/lib/data/servers";
import { hasCapability } from "@/lib/membership";
import { DatabaseOverview } from "@/components/storage/database-overview";
import { DataCopyNotice } from "@/components/shared/data-copy-notice";

export default async function DatabaseOverviewPage(
  props: PageProps<"/storage/databases/[id]">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  // `revealConnection` is gated on manage_infra; without it the connection
  // string stays masked with no reveal affordance (cosmetic - the mutation is
  // the real gate).
  const [server, canReveal, canControl] = await Promise.all([
    getServerById(db.serverId),
    hasCapability("reveal_secrets"),
    hasCapability("control_databases"),
  ]);

  return (
    <div className="space-y-6">
      {/* The data a migration could not bring. Above the overview because it is
          why Restart and Redeploy are refused, and because an engine started on
          the emptied volume does not fail - it initialises a new database. */}
      <DataCopyNotice
        kind="database"
        id={db.id}
        name={db.name}
        error={db.dataCopyError}
        canAccept={canControl}
      />
      <DatabaseOverview
        db={db}
        serverName={server?.name ?? db.serverId}
        canReveal={canReveal}
      />
    </div>
  );
}
