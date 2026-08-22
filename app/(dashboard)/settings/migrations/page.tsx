import {
  canExposePorts,
  hasCapability,
  isInstanceAdmin,
  reachesWholeTeam,
} from "@/lib/membership";
import { getTeamIdentity } from "@/lib/data/teams";
import { listBuildServerChoices, listServerChoices } from "@/lib/data/servers";
import { listDokployImports } from "@/lib/data/dokploy-import";
import { PageHeader } from "@/components/shared/page-header";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { MigrationsTabs } from "@/components/settings/migrations/migrations-tabs";

export const metadata = { title: "Settings · Migrations" };

/**
 * Migrations - bringing another platform's projects over to Deplo.
 *
 * Team-scoped, not instance-admin: a team owner brings their own projects over.
 * The two instance-admin extras are handed down as flags rather than hidden
 * behind a second page - reaching a private address (what the same-machine case
 * needs) and inviting the other platform's members.
 *
 * `create_projects` is the entry gate, mirrored server-side in every mutation.
 * `reachesWholeTeam` too: a migration writes across the whole team, so a
 * narrowed token or a project-scoped role has no business starting one.
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

  const [team, servers, buildServers, runs, admin, mayExposePorts] =
    await Promise.all([
      getTeamIdentity(),
      listServerChoices(),
      // A second, wider list: a build-only host cannot RUN anything, which is
      // exactly why it belongs in the other column.
      listBuildServerChoices(),
      listDokployImports(),
      isInstanceAdmin(),
      // A migrated database keeps the host port it had over there, and that is a
      // published port like any other - so the review only offers to sort one out
      // for somebody who could publish it.
      canExposePorts(),
    ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Migrations"
        description="Bring projects, apps and their configuration over from Dokploy."
      />
      <MigrationsTabs
        teamId={team.id}
        teamName={team.name}
        servers={servers}
        buildServers={buildServers}
        runs={runs}
        isInstanceAdmin={admin}
        canExposePorts={mayExposePorts}
      />
    </div>
  );
}
