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
import {
  TakeoverCancel,
  TakeoverStep,
  TakeoverWorking,
} from "@/components/takeover/takeover-actions";
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
  if (!status || status.state === "cancelled") redirect("/");
  // The takeover is over and the machine is Deplo's: the celebration the setup
  // wizard could not show (this screen was in the way) belongs here.
  if (status.state === "removed") redirect("/?welcome=1");

  await requireUser();
  // Rendering this page IS the proof that a browser got through - see the
  // installer's own "nothing has opened this yet" advice.
  await noteBrowserReached();

  const copy = SOURCE_COPY[status.platform];
  const sourceUrl = takeoverSourceUrl(status.platform);

  // The installer is moving the ports or taking the other panel off the disk.
  // Nothing here is clickable while that happens, and this origin is about to
  // stop answering, so the wizard is not drawn behind it.
  if (status.state !== "pending")
    return (
      <Screen>
        <TakeoverWorking
          platformLabel={copy.name}
          state={status.state}
          finalUrl={finalPanelUrl()}
        />
      </Screen>
    );

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

  const step = (
    <TakeoverStep
      platformLabel={copy.name}
      finishedRunId={finished?.id ?? null}
    />
  );

  return (
    <Screen>
      {admin && <TakeoverPreflight />}
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
        prefill={{ url: sourceUrl, kind: status.platform }}
        takeoverStep={step}
        // Everything came across and the report has been closed, so the last
        // step is the only one with anything left in it.
        startOnTakeover={finished != null && resumable == null}
      />
      <TakeoverCancel platformLabel={copy.name} />
    </Screen>
  );
}

/** The mark and nothing else: until the ports have moved there is no dashboard
 *  behind this screen to offer a way back to. */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <div className="deplo-graph-bg pointer-events-none absolute inset-0 opacity-[0.5]" />
      <header className="relative z-10 px-6 py-5">
        <DeploLogo />
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-xl space-y-6">{children}</div>
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
