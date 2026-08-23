import { notFound } from "next/navigation";
import Link from "next/link";
import { Suspense, type ElementType } from "react";
import {
  Server as ServerIcon,
  Cpu,
  MemoryStick,
  HardDrive,
  Boxes,
  Settings2,
  Hammer,
  Archive,
  DownloadCloud,
} from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { DeploMark } from "@/components/logo";
import { AddServer } from "@/components/servers/add-server";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { listAllServers, listAllServerTeamIds } from "@/lib/data/servers";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { listAllTeamsForAdmin } from "@/lib/data/teams";
import { isInstanceAdmin } from "@/lib/membership";
import { hydrateServerSpecs } from "@/lib/data/monitoring";
import { serverLabel } from "@/lib/utils";
import { reportedAgentVersion } from "@/lib/version";
import type { Server } from "@/lib/types";
import type { TeamOption } from "@/components/servers/server-team-access";
import { CheckUpdatesButton } from "./check-updates-button";
import { AgentVersionBadge } from "./agent-version-badge";
import { ServerHealthChip } from "./server-health-chip";
import { ServerTraefikBadge } from "./server-traefik-badge";
import {
  ServerHealthProvider,
  type ServerHealthState,
} from "./server-health-provider";
import { CheckStatusButton, CheckAllStatusButton } from "./check-status-button";
import { UninstallAgentMenu } from "./uninstall-agent-menu";

export const metadata = { title: "Servers" };

/** One hardware-spec tile: an icon + label over a big value + unit. */
function Spec({
  icon: Icon,
  label,
  value,
  unit,
}: {
  icon: ElementType;
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

/**
 * The four capacity tiles.
 *
 * They are the ONE thing on this page that can wait on a network round trip: a
 * server nobody has measured yet is dialed here, in the render (see
 * `hydrateServerSpecs`), and that dial is allowed four seconds. Awaited inline
 * it held back the whole page - the header, every card, the health chips - for
 * a number that fills four small boxes. So it is awaited here instead, behind
 * the card's own <Suspense>, and everything else paints immediately.
 *
 * A fleet whose specs are all stored (the normal case) resolves before the
 * first flush, so nothing flickers: the skeleton is for the one card that is
 * genuinely being measured.
 */
async function SpecTiles({ specs }: { specs: Promise<Server> }) {
  const server = await specs;
  // Specs are stored capacity (persisted from the agent); 0 means not-yet-measured
  // or unprovisioned — show an em dash rather than a misleading "0".
  const ramGb = server.memoryMb ? Math.round(server.memoryMb / 1024) : 0;
  const num = (n: number) => (n > 0 ? String(n) : "—");
  return (
    <>
      <Spec
        icon={Cpu}
        label="CPU"
        value={num(server.cpuCores)}
        unit={server.cpuCores === 1 ? "core" : "cores"}
      />
      <Spec icon={MemoryStick} label="Memory" value={num(ramGb)} unit="GB RAM" />
      <Spec icon={HardDrive} label="Disk" value={num(server.diskGb)} unit="GB" />
      <Spec
        icon={Boxes}
        label="Docker"
        value={server.dockerVersion || "—"}
        unit="engine"
      />
    </>
  );
}

/** Placeholder for {@link SpecTiles}: the same four boxes, same heights. */
function SpecTilesSkeleton() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-1.5">
            <Skeleton className="size-3.5 rounded" />
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <Skeleton className="h-5 w-8" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
      ))}
    </>
  );
}

function ServerCard({
  server,
  specs,
  accessTeamIds,
  isDeploHost,
}: {
  server: Server;
  /** The same server with its capacity measured, still in flight - see
   *  {@link SpecTiles}. Everything else on the card reads `server`. */
  specs: Promise<Server>;
  accessTeamIds: string[];
  /**
   * True for the ONE host that also runs the Deplo control plane (dashboard + API),
   * not just the deploy agent. It gets a distinct role badge so an operator can tell
   * the box they must never tear down apart from the interchangeable remotes.
   */
  isDeploHost: boolean;
}) {
  const agentVersion = reportedAgentVersion(server);
  const accessLabel = server.allTeams
    ? "All teams"
    : `${accessTeamIds.length} team${accessTeamIds.length === 1 ? "" : "s"}`;
  return (
    <Card className="transition-colors hover:border-foreground/20">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* The chip owns BOTH the dot and the label: the status and its age are one
              fact, and splitting them across two elements is how a page ends up
              rendering a confident green dot next to a status nobody has verified. */}
          <CardTitle className="truncate">{serverLabel(server)}</CardTitle>
          {/* Role: the host running Deplo (control plane + deploys) vs a remote that
              only runs the deploy agent. Made explicit on BOTH so the contrast is the
              message, not a lone badge you have to know is absent elsewhere. */}
          {isDeploHost ? (
            <Badge
              className="shrink-0 gap-1"
              title="This host runs the Deplo control plane (the dashboard and API) in addition to your deployments. Removing it takes down Deplo itself."
            >
              {/* The Deplo mark itself (currentColor, so it takes the badge's
                  primary-foreground) — this IS the control-plane host, so brand it. */}
              <DeploMark size={12} className="text-current" />
              Deplo host
            </Badge>
          ) : (
            <Badge
              variant="muted"
              className="shrink-0 gap-1"
              title="A remote host: it runs only the deploy agent, executing deployments Deplo sends it over mTLS."
            >
              <ServerIcon className="size-3" />
              Remote
            </Badge>
          )}
          {/* A specialised host says so next to its name. Without it the page reads
              as a list of interchangeable servers, and the one that runs nothing
              looks like the one that is broken. */}
          {server.buildOnly && (
            <Badge
              variant="muted"
              className="shrink-0 gap-1"
              title="This server only builds images, for apps that run on your other servers. Nothing is deployed here and it has no proxy."
            >
              <Hammer className="size-3" />
              Build only
            </Badge>
          )}
          {server.storageOnly && (
            <Badge
              variant="muted"
              className="shrink-0 gap-1"
              title="This server only holds backup files. It has no Docker and nothing is deployed here."
            >
              <Archive className="size-3" />
              Backups only
            </Badge>
          )}
          {server.importOnly && (
            <Badge
              variant="muted"
              className="shrink-0 gap-1"
              title="Another platform's host. Deplo installed its agent there to read the data being imported, and removes it when the migration is done."
            >
              <DownloadCloud className="size-3" />
              Migration source
            </Badge>
          )}
          <ServerHealthChip
            serverId={server.id}
            fallback={{
              status: server.status,
              checkedAt: server.statusCheckedAt ?? null,
              message: server.statusMessage ?? null,
              traefikEnabled: server.traefikEnabled,
              lastReachedAt: server.lastSeenAt ?? null,
            }}
          />
          <Badge variant="muted" title="Which teams can deploy to this server">
            {accessLabel}
          </Badge>
          {/* Every server is a bootstrapped agent now (the host running Deplo
              included), so the management page applies to all of them. The card
              stays a summary: everything you can DO to a server lives on its own
              page, where each action has room to say what it interrupts. */}
          {/* A migration source has no management page - there is nothing to manage
              on a machine we do not run - so its card carries the one action it
              has instead of the fleet's two. */}
          <div className="ml-auto flex items-center gap-1">
            {server.importOnly ? (
              <UninstallAgentMenu
                serverId={server.id}
                serverName={serverLabel(server)}
                provisioned={Boolean(server.agent?.certFingerprint)}
              />
            ) : (
              <>
                <CheckStatusButton
                  serverId={server.id}
                  serverName={serverLabel(server)}
                />
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/settings/servers/${server.id}`}>
                    <Settings2 className="size-4" />
                    Manage
                  </Link>
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="font-mono text-muted-foreground">{server.ip}</span>
          {/* Reads the SAME live observation as the health chip above — a stored
              traefikEnabled rendered on its own would keep claiming "on" for a host
              that has been offline for weeks. */}
          <ServerTraefikBadge
            serverId={server.id}
            fallback={{
              status: server.status,
              checkedAt: server.statusCheckedAt ?? null,
              message: server.statusMessage ?? null,
              traefikEnabled: server.traefikEnabled,
              lastReachedAt: server.lastSeenAt ?? null,
            }}
          />
          <AgentVersionBadge version={agentVersion} />
        </div>
      </CardHeader>
      {/* Capacity is fleet information. A migration source is never measured (we
          do not poll a machine we do not run), so four "—" tiles would only read
          as a broken card. */}
      {!server.importOnly && (
        <CardContent>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Suspense fallback={<SpecTilesSkeleton />}>
              <SpecTiles specs={specs} />
            </Suspense>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export default async function ServersPage(
  props: PageProps<"/settings/servers">,
) {
  // Server administration is an instance-wide concern, and the management view
  // lists EVERY server (including ones restricted to other teams) — so it is
  // instance-admin-only, not the per-team manage_infra capability. Members reach
  // servers only through the team-scoped deploy pickers, never this page.
  if (!(await isInstanceAdmin())) notFound();

  // The global "New ▸ Add server" action links here with ?new=1 to open the
  // register dialog straight away.
  const { new: newParam } = await props.searchParams;
  const autoOpenServer =
    (Array.isArray(newParam) ? newParam[0] : newParam) === "1";

  const [serversRaw, serverTeamIds, teamsRaw] =
    await Promise.all([
      listAllServers(),
      listAllServerTeamIds(),
      // The team list feeds the per-server "Team access" editor. Read it via the
      // instance-admin variant so it matches this page's admin-only gate — the
      // manage_infra-scoped listAllTeams would reject an admin who isn't a
      // manage_infra member of their active team.
      listAllTeamsForAdmin(),
    ]);
  // Fill in capacity specs for the static cards (measures an unmeasured server
  // once, then reuses the persisted values). No per-second polling anymore.
  //
  // Deliberately NOT awaited: measuring dials the agent, and an unreachable host
  // spends the full four-second cap before giving up. Awaited here that cap was
  // the whole page's - the operator who just added a server waited on the box
  // they added to render the page that says whether it answered. Each card
  // streams its own tiles instead (see `SpecTiles`); a rejection degrades to the
  // stored capacity rather than to an error boundary over the fleet.
  const measured = hydrateServerSpecs(serversRaw)
    .catch(() => serversRaw)
    .then((list) => new Map(list.map((s) => [s.id, s])));
  // A server that already HAS its capacity stored is never re-measured (that is
  // `hydrateServerSpecs`'s own rule), so it hands its tiles over resolved and
  // never renders a placeholder. Only the box someone just added waits.
  const specsFor = (server: Server) =>
    server.cpuCores > 0
      ? Promise.resolve(server)
      : measured.then((m) => m.get(server.id) ?? server);
  const teams: TeamOption[] = teamsRaw.map((t) => ({ id: t.id, name: t.name }));

  // Which server (if any) is the host running Deplo itself — computed once, then
  // used both to pull it to the front and to badge its card. Sorting it first makes
  // the "this is the control-plane box" signal impossible to miss without reordering
  // the interchangeable remotes among themselves (they keep their creation order).
  const selfAddrs = deploHostSelfAddresses();
  const servers = [...serversRaw].sort(
    (a, b) =>
      Number(isDeploHostServer(b, selfAddrs)) -
      Number(isDeploHostServer(a, selfAddrs)),
  );

  // Migration sources are listed apart from the fleet, and counted apart from it:
  // they are other platforms' machines, borrowed for one import and given back.
  // Mixed into the grid they read as servers someone forgot to configure - which
  // is exactly the confusion this section exists to end.
  const fleet = servers.filter((s) => !s.importOnly);
  const migrationSources = servers.filter((s) => s.importOnly);

  // The LAST OBSERVED health of each server, handed to the client so the cards paint
  // immediately. It is a seed, not the answer: <ServerHealthProvider> re-probes every
  // agent on mount, and the chip refuses to paint any of this once it is stale. The
  // probe deliberately does NOT run here — dialing every agent inside the render would
  // make the one page an operator opens *because* a host is broken as slow as that
  // broken host, on every single load.
  // Straight from the stored rows: the in-render measurement is not folded in
  // any more, now that it streams. It never belonged here anyway - the seed is
  // the LAST OBSERVED health, and the sweep is what makes it current.
  const healthSeed: Record<string, ServerHealthState> = Object.fromEntries(
    servers.map((s) => [
      s.id,
      {
        status: s.status,
        checkedAt: s.statusCheckedAt ?? null,
        message: s.statusMessage ?? null,
        traefikEnabled: s.traefikEnabled,
        lastReachedAt: s.lastSeenAt ?? null,
      },
    ]),
  );

  return (
    <ServerHealthProvider seed={healthSeed}>
      <div className="space-y-6">
        {/* The install flow is explained ONCE, in the title's InfoTip — it used to live on
            the "Add a server" card, which is gone now that Add is a header action. It stays
            on the page (not inside the dialog) so an operator can read it before they click. */}
        <PageHeader
          title={
            <span className="flex items-center gap-2">
              Servers
              <InfoTip
                content={
                  <>
                    Start with <strong>this host</strong>: add it (use its IP),
                    then run the one-time install command it gives you on the box
                    to install the agent. Add more Linux hosts the same way. The
                    agent calls home and provisions itself — Deplo never needs
                    SSH access to your servers.
                  </>
                }
              />
            </span>
          }
          description="Connected Docker hosts running your deployments."
          actions={
            <>
              <CheckAllStatusButton />
              <CheckUpdatesButton />
              {/* The ONE mounted AddServer on this page: a second instance would also
                  answer ?new=1 and open two dialogs at once. */}
              <AddServer autoOpen={autoOpenServer} teams={teams} />
            </>
          }
        />

        {fleet.length === 0 ? (
          <EmptyState
            icon={ServerIcon}
            title="No servers connected"
            description="Use Add above to register your first Linux host, then run the one-time install command it gives you on the box."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {fleet.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                specs={specsFor(server)}
                accessTeamIds={serverTeamIds.get(server.id) ?? []}
                isDeploHost={isDeploHostServer(server, selfAddrs)}
              />
            ))}
          </div>
        )}

        {migrationSources.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Migration sources
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Only used to import from another platform. Nothing is deployed here,
              and Deplo removes its agent when the migration is done.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {migrationSources.map((server) => (
                <ServerCard
                  key={server.id}
                  server={server}
                  specs={specsFor(server)}
                  accessTeamIds={serverTeamIds.get(server.id) ?? []}
                  isDeploHost={false}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </ServerHealthProvider>
  );
}
