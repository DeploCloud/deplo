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
import { MigrationActivityProvider } from "@/components/layout/migration-activity";
import { MigrationWizard } from "@/components/settings/migrations/migration-wizard";
import { TakeoverCancel } from "@/components/takeover/takeover-actions";
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
  // The machine is Deplo's: there is nothing left here to show. Land the way
  // the step itself does, celebration included - a refresh mid-removal can
  // reach this before the step's own poll sees `removed`.
  if (status.state === "removed")
    redirect(
      `/?welcome=1&takeover=${encodeURIComponent(SOURCE_COPY[status.platform].name)}`,
    );

  await requireUser();
  // Rendering this page IS the proof that a browser got through - see the
  // installer's own "nothing has opened this yet" advice.
  await noteBrowserReached();

  const copy = SOURCE_COPY[status.platform];
  const sourceUrl = takeoverSourceUrl(status.platform);

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
    <Screen>
      {/* The live migration feed, which the dashboard shell provides everywhere
          else. Without it this screen cannot see the run it just started. */}
      <MigrationActivityProvider key={team.id}>
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
          // Measured before anything moves, and only when something is going to
          // be copied - it probes the agent, which the cutover is busy with.
          preflight={
            admin && status.state === "pending" ? <TakeoverPreflight /> : null
          }
          takeover={{
            platformLabel: copy.name,
            state: status.state,
            finishedRunId: finished?.id ?? null,
            finalUrl: finalPanelUrl(),
            error: status.error,
          }}
          // Everything came across and the report has been closed, so the last
          // step is the only one with anything left in it.
          startOnTakeover={finished != null && resumable == null}
        />
      </MigrationActivityProvider>
      {(status.state === "pending" ||
        status.state === "ready" ||
        status.state === "failed") && (
        <TakeoverCancel platformLabel={copy.name} />
      )}
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

/**
 * Where this dashboard answers once the ports have moved: its host on 443, never
 * a port this container was started with while another panel still held 443.
 */
function finalPanelUrl(): string {
  const pub = process.env.DEPLO_PUBLIC_URL?.trim() ?? "";
  try {
    if (pub.startsWith("https://")) return `https://${new URL(pub).hostname}`;
  } catch {
    /* not an address: fall through to the generated host */
  }
  return `https://${panelFallbackHost()}`;
}
