import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { isInstanceAdmin } from "@/lib/membership";
import { noteBrowserReached, takeoverStatus } from "@/lib/data/takeover";
import { getTeamIdentity } from "@/lib/data/teams";
import { listBuildServerChoices, listServerChoices } from "@/lib/data/servers";
import {
  listMigrationRuns,
  listMigrationTargetTeams,
  resumableMigration,
} from "@/lib/data/migration-import";
import { canExposePorts } from "@/lib/membership";
import { panelFallbackHost, sameMachineHost } from "@/lib/deploy/domains";
import { MigrationWizard } from "@/components/settings/migrations/migration-wizard";
import { TakeoverActions } from "@/components/takeover/takeover-actions";
import { TakeoverPreflight } from "@/components/takeover/takeover-preflight";
import {
  SourceMark,
  SOURCE_COPY,
} from "@/components/settings/migrations/sources";

export const metadata = { title: "Take over this machine" };

/**
 * The whole screen while Deplo is replacing another panel on this machine. Not a
 * settings page: until the ports are Deplo's there is nothing else to do here,
 * and a dashboard around it would offer deploys onto a machine somebody else
 * still owns.
 */
export default async function TakeoverPage() {
  const status = await takeoverStatus();
  if (!status || status.state === "removed" || status.state === "cancelled")
    redirect("/");

  await requireUser();
  // Rendering this page IS the proof that a browser got through - see the
  // installer's own "nothing has opened this yet" advice.
  await noteBrowserReached();

  const copy = SOURCE_COPY[status.platform];
  const [
    team,
    targetTeams,
    servers,
    buildServers,
    runs,
    resumable,
    admin,
    mayExposePorts,
  ] = await Promise.all([
    getTeamIdentity(),
    listMigrationTargetTeams(),
    listServerChoices(),
    listBuildServerChoices(),
    listMigrationRuns(),
    resumableMigration(),
    isInstanceAdmin(),
    canExposePorts(),
  ]);

  // Something has to have come across before there is any point taking the ports.
  const finished = runs.find((r) => r.status === "done") ?? null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10">
      <div className="flex items-start gap-3">
        <SourceMark kind={status.platform} className="mt-1 size-8 shrink-0" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">
            Replacing {copy.name} on this machine
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Bring your projects across, then hand Deplo the ports. Nothing is
            deployed and nothing is removed until you say so.
          </p>
        </div>
      </div>

      {status.state === "pending" && admin && <TakeoverPreflight />}

      {status.state === "pending" && (
        <MigrationWizard
          teamId={team.id}
          teamName={team.name}
          teamAvatarUrl={team.avatarUrl}
          targetTeams={targetTeams}
          servers={servers}
          buildServers={buildServers}
          resumable={resumable}
          sameMachineHost={sameMachineHost()}
          isInstanceAdmin={admin}
          canExposePorts={mayExposePorts}
          prefill={{
            url: takeoverSourceUrl(status.platform),
            kind: status.platform,
          }}
        />
      )}

      <TakeoverActions
        platformLabel={copy.name}
        platform={status.platform}
        sourceUrl={takeoverSourceUrl(status.platform)}
        state={status.state}
        finishedRunId={finished?.id ?? null}
        finalUrl={finalPanelUrl()}
      />
    </div>
  );
}

/** Where the other panel answers on this machine, from the installer's own IP. */
function takeoverSourceUrl(platform: "dokploy" | "coolify"): string {
  const ip = process.env.DEPLO_SERVER_IP?.trim() || "127.0.0.1";
  return `http://${ip}:${platform === "coolify" ? 8000 : 3000}`;
}

/** Where this dashboard answers once the ports have moved. */
function finalPanelUrl(): string {
  const pub = process.env.DEPLO_PUBLIC_URL?.trim() ?? "";
  if (pub.startsWith("https://")) return pub;
  return `https://${panelFallbackHost()}`;
}
