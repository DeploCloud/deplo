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
import { SOURCE_COPY } from "@/components/settings/migrations/sources";
import { DeploLogo } from "@/components/logo";

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
    <div className="relative flex min-h-dvh flex-col">
      <div className="deplo-graph-bg pointer-events-none absolute inset-0 opacity-[0.5]" />
      {/* The mark and nothing else: until the ports have moved there is no
          dashboard behind this screen to offer a way back to. */}
      <header className="relative z-10 px-6 py-5">
        <DeploLogo />
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-xl space-y-6">
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
      </main>
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
