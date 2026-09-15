import { notFound } from "next/navigation";

import { canExposePorts, isInstanceAdmin } from "@/lib/membership";
import { getTeamIdentity } from "@/lib/data/teams";
import {
  listBuildServerChoices,
  listServerChoices,
} from "@/lib/data/servers/roster";
import { listMigrationTargetTeams } from "@/lib/data/migration-import/gates";
import {
  listAllMigrationRuns,
  resumableMigrationAnywhere,
} from "@/lib/data/migration-import/run-queries";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { MigrationsTabs } from "@/components/settings/migrations/migrations-tabs";
import { sameMachineHost } from "@/lib/deploy/domains";

export const metadata = { title: "Settings · Migrations" };

export default async function SettingsMigrationsPage() {
  if (!(await isInstanceAdmin())) notFound();

  const [team, targetTeams, servers, buildServers, runs, resumable, mayExpose] =
    await Promise.all([
      getTeamIdentity(),
      listMigrationTargetTeams(),
      listServerChoices(),
      listBuildServerChoices(),
      listAllMigrationRuns(),
      resumableMigrationAnywhere(),
      canExposePorts(),
    ]);

  return (
    <div className="space-y-3">
      <PageHeader
        docs="migration.dokploy"
        title={
          <span className="flex items-center gap-2">
            Migrations
            <BetaChip />
          </span>
        }
        description="Bring another panel's teams over, each into a team here."
      />
      <MigrationsTabs
        teamId={team.id}
        targetTeams={targetTeams}
        servers={servers}
        buildServers={buildServers}
        runs={runs}
        resumable={resumable}
        sameMachineHost={sameMachineHost()}
        canExposePorts={mayExpose}
      />
    </div>
  );
}
