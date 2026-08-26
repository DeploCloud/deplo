import {
  canExposePorts,
  hasCapability,
  isInstanceAdmin,
  reachesWholeTeam,
} from "@/lib/membership";
import { getTeamIdentity } from "@/lib/data/teams";
import { listBuildServerChoices, listServerChoices } from "@/lib/data/servers";
import {
  listMigrationRuns,
  resumableMigration,
} from "@/lib/data/migration-import";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { MigrationsTabs } from "@/components/settings/migrations/migrations-tabs";

export const metadata = { title: "Settings · Migrations" };

/**
 * Migrations - bringing another platform's projects over to Deplo.
 * `create_projects` is the entry gate, mirrored server-side in every mutation.
 */
export default async function SettingsMigrationsPage() {
  if (!(await reachesWholeTeam()) || !(await hasCapability("create_projects")))
    return (
      <OutsideYourAccess
        title="Migrations"
        description="Bring projects over from Dokploy."
        what="Migrations"
      />
    );

  const [team, servers, buildServers, runs, resumable, admin, mayExposePorts] =
    await Promise.all([
      getTeamIdentity(),
      listServerChoices(),
      // A second, wider list: a build-only host cannot RUN anything, which is
      // exactly why it belongs in the other column.
      listBuildServerChoices(),
      listMigrationRuns(),
      // The run to open on, if any: the team's one in flight, or one this person has not
      // closed the report of.
      resumableMigration(),
      isInstanceAdmin(),
      // A migrated database keeps the host port it had over there, and that is a
      // published port like any other - so the review only offers to sort one out
      // for somebody who could publish it.
      canExposePorts(),
    ]);

  return (
    <div className="space-y-8">
      <PageHeader
        docs="migration.dokploy"
        title={
          <span className="flex items-center gap-2">
            Migrations
            <BetaChip />
          </span>
        }
        description="Bring projects, apps and their configuration over from Dokploy."
      />
      <MigrationsTabs
        teamId={team.id}
        teamName={team.name}
        teamAvatarUrl={team.avatarUrl}
        servers={servers}
        buildServers={buildServers}
        runs={runs}
        resumable={resumable}
        isInstanceAdmin={admin}
        canExposePorts={mayExposePorts}
      />
    </div>
  );
}
