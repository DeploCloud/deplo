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

export default async function TakeoverPage() {
  const status = await takeoverStatus();
  if (!status || status.state === "cancelled") redirect("/");
  if (status.state === "removed")
    redirect(
      `/?welcome=1&takeover=${encodeURIComponent(SOURCE_COPY[status.platform].name)}`,
    );

  await requireUser();
  await noteBrowserReached();

  const copy = SOURCE_COPY[status.platform];
  const sourceUrl = takeoverSourceUrl(status.platform);

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

  const finished = runs.find((r) => r.status === "done") ?? null;
  const dataLoss = finished && admin ? await takeoverDataLoss() : [];

  return (
    <Screen
      footer={
        (status.state === "pending" || status.state === "failed") && (
          <TakeoverCancel
            platformLabel={copy.name}
            tokenLabel={copy.tokenLabel}
          />
        )
      }
    >
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
      <AuthChrome />
      <header className="relative z-10 px-6 py-5">
        <DeploLogo />
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-8">
        <div className="w-full max-w-3xl space-y-6">{children}</div>
      </main>
      {footer && <footer className="relative z-10 px-4 pb-14">{footer}</footer>}
    </div>
  );
}

function takeoverSourceUrl(platform: "dokploy" | "coolify"): string {
  const ip = process.env.DEPLO_SERVER_IP?.trim() || "127.0.0.1";
  return `http://${ip}:${platform === "coolify" ? 8000 : 3000}`;
}

function finalPanelUrl(): string {
  const pub = process.env.DEPLO_PUBLIC_URL?.trim() ?? "";
  try {
    if (pub.startsWith("https://")) return `https://${new URL(pub).hostname}`;
  } catch {}
  return `https://${panelFallbackHost()}`;
}
