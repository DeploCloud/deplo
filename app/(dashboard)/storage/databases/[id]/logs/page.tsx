import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
import { getDatabaseLogsInfo } from "@/lib/data/database-console";
import { PageHeader } from "@/components/shared/page-header";
import { DatabaseLogs } from "@/components/storage/database-logs";

export const metadata = { title: "Logs" };

export default async function DatabaseLogsPage(
  props: PageProps<"/storage/databases/[id]/logs">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  const info = await getDatabaseLogsInfo(id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Logs"
        description="Live output from the database's container — including while it is crash-looping."
      />
      <DatabaseLogs
        id={db.id}
        status={db.status}
        instances={info?.instances ?? []}
        streamable={!!info?.streamable}
      />
    </div>
  );
}
