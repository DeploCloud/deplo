import {
  canExposePorts,
  hasCapability,
  isInstanceAdmin,
  reachesWholeTeam,
} from "@/lib/membership";
import { getTeamIdentity } from "@/lib/data/teams";
import { getCurrentUser } from "@/lib/auth";
import { listBuildServerChoices, listServerChoices } from "@/lib/data/servers";
import {
  listDokployImports,
  resumableDokployImport,
} from "@/lib/data/dokploy-import";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
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

  const [
    team,
    servers,
    buildServers,
    runs,
    resumable,
    admin,
    mayExposePorts,
    viewer,
  ] = await Promise.all([
    getTeamIdentity(),
    listServerChoices(),
    // A second, wider list: a build-only host cannot RUN anything, which is
    // exactly why it belongs in the other column.
    listBuildServerChoices(),
    listDokployImports(),
    // The run this person is in the middle of, if any: the wizard opens on it
    // rather than on an empty form, so leaving the page and coming back gives
    // back the screen they left. Null is the normal case.
    resumableDokployImport(),
    isInstanceAdmin(),
    // A migrated database keeps the host port it had over there, and that is a
    // published port like any other - so the review only offers to sort one out
    // for somebody who could publish it.
    canExposePorts(),
    // Who is looking, so a migration already in flight can tell the person who
    // started it apart from a teammate who just walked in on it.
    getCurrentUser(),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
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
        viewerName={viewer?.name ?? ""}
      />
    </div>
  );
}
