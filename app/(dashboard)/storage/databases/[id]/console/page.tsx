// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getDatabase } from "@/lib/data/databases";
import { getDatabaseConsoleInfo } from "@/lib/data/database-console";
import { hasCapability } from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";
import { DatabaseConsole } from "@/components/storage/database-console";

export const metadata = { title: "Console" };

export default async function DatabaseConsolePage(
  props: PageProps<"/storage/databases/[id]/console">,
) {
  const { id } = await props.params;
  const db = await getDatabase(id);
  if (!db) notFound();

  // A live shell into the database container is an infra-class operation - the
  // sidebar chip is hidden without it, but guard the page too.
  if (!(await hasCapability("open_database_console"))) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <EmptyState
          icon={Lock}
          title="No access to the console"
          docs="roles.floorCeiling"
          description="You don't have permission to open a console into this database. Ask a team admin for the “Open a database console” permission."
        />
      </div>
    );
  }

  const info = await getDatabaseConsoleInfo(id);

  // Full-bleed, like an App's console and both log panes: the terminal fills the
  // frame and its toolbar carries the name, so there is no page header here.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DatabaseConsole
        id={db.id}
        title={{
          label: db.name,
          href: `/storage/databases/${db.id}`,
          settingsHref: `/storage/databases/${db.id}/settings/advanced`,
        }}
        status={db.status}
        instances={info?.instances ?? []}
      />
    </div>
  );
}
