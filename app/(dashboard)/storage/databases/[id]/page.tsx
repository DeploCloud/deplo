import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
import { getServerById } from "@/lib/data/servers";
import { DatabaseOverview } from "@/components/storage/database-overview";

export default async function DatabaseOverviewPage(
  props: PageProps<"/storage/databases/[id]">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  const server = await getServerById(db.serverId);

  return <DatabaseOverview db={db} serverName={server?.name ?? db.serverId} />;
}
