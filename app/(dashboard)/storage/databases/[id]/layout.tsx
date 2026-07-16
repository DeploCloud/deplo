import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
import { truncate } from "@/lib/utils";
import { DB_ICONS } from "@/components/storage/db-engines";
import {
  DatabaseLiveStatusProvider,
  type LiveDatabase,
} from "@/components/storage/database-live-status";
import { DatabaseStatusBadge } from "@/components/storage/database-status-badge";
import { DatabaseControls } from "@/components/storage/database-controls";
import { DatabaseRedeployButton } from "@/components/storage/database-redeploy-button";
import { Database as DatabaseIcon } from "lucide-react";

const DB_TITLE_MAX = 24;

export async function generateMetadata(
  props: LayoutProps<"/storage/databases/[id]">,
): Promise<Metadata> {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) return { title: "Database" };
  const name = truncate(db.name, DB_TITLE_MAX);
  return {
    title: {
      template: `${name} – %s – Deplo`,
      default: `${name} – Overview – Deplo`,
    },
  };
}

export default async function DatabaseLayout(
  props: LayoutProps<"/storage/databases/[id]">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  const Icon = DB_ICONS[db.type] ?? DatabaseIcon;
  const initialLive: LiveDatabase = {
    id: db.id,
    name: db.name,
    status: db.status,
  };

  return (
    <DatabaseLiveStatusProvider key={db.id} initial={initialLive}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-lg border border-border bg-secondary text-foreground">
              <Icon className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">{db.name}</h1>
                <DatabaseStatusBadge id={db.id} status={db.status} />
              </div>
              <p className="text-sm capitalize text-muted-foreground">
                {db.type} · v{db.version}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DatabaseControls id={db.id} status={db.status} />
            <DatabaseRedeployButton id={db.id} />
          </div>
        </div>

        {props.children}
      </div>
    </DatabaseLiveStatusProvider>
  );
}
