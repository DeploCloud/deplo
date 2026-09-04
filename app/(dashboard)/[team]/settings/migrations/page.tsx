import { notFound } from "next/navigation";

import { canExposePorts, isInstanceAdmin } from "@/lib/membership";
import { getTeamIdentity } from "@/lib/data/teams";
import { listBuildServerChoices, listServerChoices } from "@/lib/data/servers";
import {
  listAllMigrationRuns,
  listMigrationTargetTeams,
  resumableMigrationAnywhere,
} from "@/lib/data/migration-import";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { MigrationsTabs } from "@/components/settings/migrations/migrations-tabs";
import { sameMachineHost } from "@/lib/deploy/domains";

export const metadata = { title: "Settings · Migrations" };

/**
 * Settings → System → Migrations: another panel's teams, each landing in a team
 * of the operator's choosing. Instance admins, like its neighbours; landing in a
 * team still needs `create_projects` there, checked server-side on every call.
 */
export default async function SettingsMigrationsPage() {
  if (!(await isInstanceAdmin())) notFound();

  const [team, targetTeams, servers, buildServers, runs, resumable, mayExpose] =
    await Promise.all([
      getTeamIdentity(),
      // Where a source team may land: the teams this person may create
      // projects in. A new team is always on offer besides these.
      listMigrationTargetTeams(),
      // The page's own team's fleet, as the first answer; the wizard re-reads
      // the fleet of each team a source team lands in.
      listServerChoices(),
      listBuildServerChoices(),
      listAllMigrationRuns(),
      // The run to open on, whichever team it landed in.
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
