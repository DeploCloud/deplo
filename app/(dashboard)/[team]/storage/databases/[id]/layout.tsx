import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases/rows";
import { truncate } from "@/lib/utils";
import {
  DatabaseLiveStatusProvider,
  type LiveDatabase,
} from "@/components/storage/database-live-status";
import { hasCapability } from "@/lib/membership";
import { DbNavSync } from "@/components/storage/db-nav-store";
import { DetailFrame } from "@/components/layout/detail-frame";
import { DatabaseHeader } from "@/components/storage/database-header";

const DB_TITLE_MAX = 24;

export async function generateMetadata(
  props: LayoutProps<"/[team]/storage/databases/[id]">,
): Promise<Metadata> {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) return { title: "Database" };
  const name = truncate(db.name, DB_TITLE_MAX);
  return {
    title: {
      template: `${name} - %s - Deplo`,
      default: `${name} - Overview - Deplo`,
    },
  };
}

export default async function DatabaseLayout(
  props: LayoutProps<"/[team]/storage/databases/[id]">,
) {
  const { id } = await props.params;
  const [db, canConfigure, canDelete] = await Promise.all([
    getDatabase(id),
    hasCapability("configure_databases"),
    hasCapability("delete_databases"),
  ]);
  if (!db) notFound();

  const initialLive: LiveDatabase = {
    id: db.id,
    name: db.name,
    status: db.status,
    restartLoopStoppedAt: db.restartLoopStoppedAt,
  };

  return (
    <DatabaseLiveStatusProvider key={db.id} initial={initialLive}>
      <DbNavSync
        id={db.id}
        cronsEnabled={db.cronEnabled}
        logo={db.logo}
        type={db.type}
      />
      <DetailFrame
        locked={Boolean(db.migrationRunId)}
        mobile={{
          root: `/storage/databases/${db.id}`,
          name: db.name,
          parent: { href: "/storage", label: "Storage" },
        }}
        header={
          <DatabaseHeader
            db={{
              id: db.id,
              name: db.name,
              type: db.type,
              logo: db.logo,
              version: db.version,
              status: db.status,
            }}
            canConfigure={canConfigure}
            canDelete={canDelete}
          />
        }
      >
        {props.children}
      </DetailFrame>
    </DatabaseLiveStatusProvider>
  );
}
