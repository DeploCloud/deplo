import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/current-user";
import { isInstanceAdmin } from "@/lib/membership";
import {
  noteBrowserReached,
  takeoverDataLoss,
  takeoverStatus,
} from "@/lib/data/takeover";
import { getTeamIdentity } from "@/lib/data/teams";
import {
  listBuildServerChoices,
  listServerChoices,
} from "@/lib/data/servers/roster";
import { listMigrationTargetTeams } from "@/lib/data/migration-import/gates";
import {
  listAllMigrationRuns,
  listMigrationRuns,
  resumableMigration,
  resumableMigrationAnywhere,
} from "@/lib/data/migration-import/run-queries";
import { canExposePorts } from "@/lib/membership";
import { panelFallbackHost, sameMachineHost } from "@/lib/deploy/domains";
import { MigrationWizard } from "@/components/settings/migrations/migration-wizard/wizard";
import { TakeoverCancel } from "@/components/takeover/takeover-actions";
import { TakeoverPreflight } from "@/components/takeover/takeover-preflight";
import { SOURCE_COPY } from "@/components/settings/migrations/sources";
import { DeploLogo } from "@/components/logo";
import { AuthChrome } from "@/components/auth/auth-chrome";

export const metadata = { title: "Take over this machine" };

// TakeoverPage is the whole screen while Deplo replaces another panel on this machine.
export default async function TakeoverPage() {
  const status = await takeoverStatus();
  if (!status || status.state === "cancelled") redirect("/");
  // A refresh mid-removal can reach this before the step's own poll sees `removed`.
  if (status.state === "removed")
    redirect(
      `/?welcome=1&takeover=${encodeURIComponent(SOURCE_COPY[status.platform].name)}`,
    );

  await requireUser();
  // Rendering this page IS the proof a browser got through, which the installer waits on.
  await noteBrowserReached();

  const copy = SOURCE_COPY[status.platform];
  const sourceUrl = takeoverSourceUrl(status.platform);

  // Each source team lands in a team of the operator's choosing, so runs are read across every team.
  const admin = await isInstanceAdmin();
  const [team, targetTeams, servers, buildServers, runs, resumable, mayExpose] =
    await Promise.all([
      getTeamIdentity(),
      listMigrationTargetTeams(),
      listServerChoices(),
      listBuildServerChoices(),
      admin ? listAllMigrationRuns() : listMigrationRuns(),
      admin ? resumableMigrationAnywhere() : resumableMigration(),
      canExposePorts(),
    ]);

  // Something has to have come across before there is any point taking the ports.
  const finished = runs.find((r) => r.status === "done") ?? null;
  // It names every team's services, so only the operator reads it.
  const dataLoss = finished && admin ? await takeoverDataLoss() : [];

  return (
    <Screen
      // Once the ports have been asked for there is nothing here to back out of.
      footer={
        (status.state === "pending" || status.state === "failed") && (
          <TakeoverCancel
            platformLabel={copy.name}
            tokenLabel={copy.tokenLabel}
          />
        )
      }
    >
      {/* The wizard watches the run it started itself, in whichever team it lands. */}
      <MigrationWizard
        teamId={team.id}
        targetTeams={targetTeams}
        servers={servers}
        buildServers={buildServers}
        resumable={resumable}
        sameMachineHost={sameMachineHost()}
        isInstanceAdmin={admin}
        canExposePorts={mayExpose}
        prefill={{ url: sourceUrl, kind: status.platform }}
        // It probes the agent, which the cutover is busy with.
        preflight={
          admin && status.state === "pending" ? <TakeoverPreflight /> : null
        }
        takeover={{
          platformLabel: copy.name,
          state: status.state,
          finishedRunId: finished?.id ?? null,
          finalUrl: finalPanelUrl(),
          error: status.error,
          dataLoss,
        }}
        // A null resumable means the report has been closed, leaving only the last step.
        startOnTakeover={finished != null && resumable == null}
      />
    </Screen>
  );
}

function Screen({
  children,
  footer,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0" />
      {/* Theme and the links every signed-out screen carries. */}
      <AuthChrome />
      <header className="relative z-10 px-6 py-5">
        <DeploLogo />
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-8">
        {/* Wide enough for the People step's grid. */}
        <div className="w-full max-w-3xl space-y-6">{children}</div>
      </main>
      {/* Clear of AuthChrome's own row of links, which sits at the page's foot. */}
      {footer && <footer className="relative z-10 px-4 pb-14">{footer}</footer>}
    </div>
  );
}

function takeoverSourceUrl(platform: "dokploy" | "coolify"): string {
  const ip = process.env.DEPLO_SERVER_IP?.trim() || "127.0.0.1";
  return `http://${ip}:${platform === "coolify" ? 8000 : 3000}`;
}

// Its host on 443, never a port this container got while another panel still held 443.
function finalPanelUrl(): string {
  const pub = process.env.DEPLO_PUBLIC_URL?.trim() ?? "";
  try {
    if (pub.startsWith("https://")) return `https://${new URL(pub).hostname}`;
  } catch {}
  return `https://${panelFallbackHost()}`;
}
