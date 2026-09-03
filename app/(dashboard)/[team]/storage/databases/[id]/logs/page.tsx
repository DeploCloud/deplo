import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
import { getDatabaseLogsInfo } from "@/lib/data/database-console";
import { DatabaseLogs } from "@/components/storage/database-logs";
import { DEFAULT_LOG_RANGE_DAYS } from "@/lib/types";

export const metadata = { title: "Logs" };

export default async function DatabaseLogsPage(
  props: PageProps<"/[team]/storage/databases/[id]/logs">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  const info = await getDatabaseLogsInfo(id);

  // Full-bleed route: the pane fills the frame, so there is no header above it.
  // See components/layout/shell-frame.tsx.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DatabaseLogs
        id={db.id}
        title={{ label: db.name, href: `/storage/databases/${db.id}` }}
        status={db.status}
        instances={info?.instances ?? []}
        streamable={!!info?.streamable}
        supportsTimeline={!!info?.supportsTimeline}
        logMaxDays={info?.logMaxDays ?? DEFAULT_LOG_RANGE_DAYS}
      />
    </div>
  );
}
