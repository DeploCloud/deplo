import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases/rows";
import { titleCase, truncate } from "@/lib/utils";
import { DB_NAMES } from "@/components/storage/db-engines";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { LogoEditLink } from "@/components/shared/logo-edit-link";
import {
  DatabaseLiveStatusProvider,
  type LiveDatabase,
} from "@/components/storage/database-live-status";
import { DatabaseStatusBadge } from "@/components/storage/database-status-badge";
import { DatabaseControls } from "@/components/storage/database-controls";
import { DatabaseActionsMenu } from "@/components/storage/database-actions-menu";
import { hasCapability } from "@/lib/membership";
import { DatabaseRedeployButton } from "@/components/storage/database-redeploy-button";
import { DbNavSync } from "@/components/storage/db-nav-store";
import { DetailFrame } from "@/components/layout/detail-frame";
import { titleClass } from "@/components/shared/page-header";

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
        header={
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <LogoEditLink
                href={`/storage/databases/${db.id}/settings`}
                label="General settings"
              >
                <DatabaseLogo type={db.type} logo={db.logo} size={44} />
              </LogoEditLink>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className={titleClass.page}>{db.name}</h1>
                  <DatabaseStatusBadge id={db.id} status={db.status} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {DB_NAMES[db.type] ?? titleCase(db.type)} database · v
                  {db.version}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DatabaseControls id={db.id} status={db.status} />
              <DatabaseRedeployButton id={db.id} />
              <DatabaseActionsMenu
                id={db.id}
                name={db.name}
                canConfigure={canConfigure}
                canDelete={canDelete}
              />
            </div>
          </div>
        }
      >
        {props.children}
      </DetailFrame>
    </DatabaseLiveStatusProvider>
  );
}
