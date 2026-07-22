import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
import { getServerById } from "@/lib/data/servers";
import { hasCapability } from "@/lib/membership";
import { DatabaseOverview } from "@/components/storage/database-overview";

export default async function DatabaseOverviewPage(
  props: PageProps<"/storage/databases/[id]">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  // `revealConnection` is gated on manage_infra; without it the connection
  // string stays masked with no reveal affordance (cosmetic — the mutation is
  // the real gate).
  const [server, canReveal] = await Promise.all([
    getServerById(db.serverId),
    hasCapability("manage_infra"),
  ]);

  return (
    <DatabaseOverview
      db={db}
      serverName={server?.name ?? db.serverId}
      canReveal={canReveal}
    />
  );
}
