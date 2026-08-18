import { hasCapability, isInstanceAdmin, reachesWholeTeam } from "@/lib/membership";
import { getTeamIdentity } from "@/lib/data/teams";
import { listServerChoices } from "@/lib/data/servers";
import { listDokployImports } from "@/lib/data/dokploy-import";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { ImportWizard } from "@/components/settings/import/import-wizard";

export const metadata = { title: "Settings · Import" };

/**
 * Import from Dokploy.
 *
 * Team-scoped, not instance-admin: a team owner brings their own projects over.
 * The two instance-admin extras are handed down as flags rather than hidden
 * behind a second page - reaching a private address (what the same-machine case
 * needs) and inviting the other platform's members.
 *
 * `create_projects` is the entry gate, mirrored server-side in every mutation.
 * `reachesWholeTeam` too: an import writes across the whole team, so a narrowed
 * token or a project-scoped role has no business starting one.
 */
export default async function SettingsImportPage() {
  if (!(await reachesWholeTeam()) || !(await hasCapability("create_projects")))
    return (
      <OutsideYourAccess
        title="Import"
        description="Bring projects over from Dokploy."
        what="Imports"
      />
    );

  const [team, servers, runs, admin] = await Promise.all([
    getTeamIdentity(),
    listServerChoices(),
    listDokployImports(),
    isInstanceAdmin(),
  ]);

  return (
    <ImportWizard
      teamId={team.id}
      teamName={team.name}
      servers={servers}
      runs={runs}
      isInstanceAdmin={admin}
    />
  );
}
