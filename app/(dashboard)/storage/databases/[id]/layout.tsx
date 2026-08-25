import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/data/databases";
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
import { DatabaseRedeployButton } from "@/components/storage/database-redeploy-button";
import { DbNavSync } from "@/components/storage/db-nav-store";
import { DetailFrame } from "@/components/layout/detail-frame";

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

  const initialLive: LiveDatabase = {
    id: db.id,
    name: db.name,
    status: db.status,
  };

  return (
    <DatabaseLiveStatusProvider key={db.id} initial={initialLive}>
      {/* Publishes this database's nav facts to the sidebar, which lives outside
          this layout and so cannot read a context. Renders nothing. */}
      <DbNavSync
        id={db.id}
        cronsEnabled={db.cronEnabled}
        logo={db.logo}
        type={db.type}
      />
      {/* Same readable width as the App pages, and the same exception: on a
          full-bleed route DetailFrame drops both the measure and the header. */}
      <DetailFrame
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
                  <h1 className="text-xl font-semibold tracking-tight">
                    {db.name}
                  </h1>
                  <DatabaseStatusBadge id={db.id} status={db.status} />
                </div>
                {/* Same slot the App header uses for its URL: a database has no
                  domain, so it always says what it is (engine display name, not
                  the raw id — "PostgreSQL", never "postgres"). */}
                <p className="text-sm text-muted-foreground">
                  {DB_NAMES[db.type] ?? titleCase(db.type)} database · v
                  {db.version}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <DatabaseControls id={db.id} status={db.status} />
              <DatabaseRedeployButton id={db.id} />
            </div>
          </div>
        }
      >
        {props.children}
      </DetailFrame>
    </DatabaseLiveStatusProvider>
  );
}
