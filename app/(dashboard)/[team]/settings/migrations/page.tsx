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
import { sourceMoveStatus } from "@/lib/data/deplo-move/source";
import {
  currentTargetMove,
  moveStatus,
  targetMoveReadiness,
} from "@/lib/data/deplo-move/target";

export const metadata = { title: "Settings · Migrations" };

export default async function SettingsMigrationsPage() {
  if (!(await isInstanceAdmin())) notFound();

  const [
    team,
    targetTeams,
    servers,
    buildServers,
    runs,
    resumable,
    mayExpose,
    sourceMove,
    targetId,
    readiness,
  ] = await Promise.all([
    getTeamIdentity(),
    listMigrationTargetTeams(),
    listServerChoices(),
    listBuildServerChoices(),
    listAllMigrationRuns(),
    resumableMigrationAnywhere(),
    canExposePorts(),
    sourceMoveStatus(),
    currentTargetMove(),
    targetMoveReadiness(),
  ]);
  // A connected move has not started: connecting again picks it up, so it shows as the form.
  const target = targetId ? await moveStatus(targetId) : null;
  const activeTargetId =
    target && target.state !== "connected" ? target.id : null;

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
        description="Bring another Deplo, Dokploy or Coolify here."
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
        move={{ source: sourceMove, activeTargetId, readiness }}
      />
    </div>
  );
}
