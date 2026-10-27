"use client";

import * as React from "react";
import {
  CheckCircle2,
  CircleFadingArrowUp,
  Hourglass,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import Link from "@/components/ui/link";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { CommandLine } from "@/components/shared/code-block";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { titleClass } from "@/components/shared/page-header";
import { installOneLiner } from "@/lib/install-script";
import { UpdateGraphic } from "@/components/settings/update-graphic";
import { gqlAction } from "@/lib/graphql-client";
import { Changelog, ChangelogSkeleton, type Release } from "./deplo-changelog";
import { FleetBehind, useFleetAgents, type FleetSummary } from "./fleet-agents";

export type { FleetSummary };

type UpdateInfo = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  next: string | null;
  nextIsStop: boolean;
  stop: UpdateStop | null;
  publishedAt: string | null;
  canary: boolean;
  error?: string | null;
  strandedServers?: { id: string; name: string; version: string | null }[];
  lastRefusedUpdate?: RefusedUpdate | null;
};

type StopServer = { id: string; name: string };

type UpdateStop = {
  version: string;
  reason: string;
  waiting: boolean;
  waitingOn?: StopServer[];
  leftBehind?: StopServer[];
};

type RefusedUpdate = {
  version: string | null;
  reason: string;
  at: string | null;
};

const UPDATES_QUERY = /* GraphQL */ `
  query DeploUpdates {
    updateInfo {
      current
      latest
      updateAvailable
      next
      nextIsStop
      stop {
        version
        reason
        waiting
        waitingOn {
          id
          name
        }
        leftBehind {
          id
          name
        }
      }
      publishedAt
      canary
      error
      strandedServers {
        id
        name
        version
      }
      lastRefusedUpdate {
        version
        reason
        at
      }
    }
    deploChangelog {
      error
      releases {
        tag
        name
        url
        publishedAt
        body
        prerelease
        current
        available
      }
    }
  }
`;

type UpdatesData = {
  updateInfo: UpdateInfo | null;
  deploChangelog: { error?: string | null; releases: Release[] } | null;
};

export function DeploUpdatesTab({
  active,
  version,
  canary,
  fleet: seed,
}: {
  active: boolean;
  version: string;
  canary: boolean;
  fleet: FleetSummary;
}) {
  const { fleet, refresh: refreshFleet } = useFleetAgents(seed);
  const [info, setInfo] = React.useState<UpdateInfo | null>(null);
  const [releases, setReleases] = React.useState<Release[] | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [updating, setUpdating] = React.useState<{
    version: string;
    logPath: string;
  } | null>(null);
  const [stalled, setStalled] = React.useState(false);
  const [manual, setManual] = React.useState<string | null>(null);
  const loaded = React.useRef(false);
  const refusedAt = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await gqlAction<UpdatesData, UpdatesData>(UPDATES_QUERY);
    if (!res.ok) {
      setListError(res.error);
      setReleases([]);
      return;
    }
    setInfo(res.data?.updateInfo ?? null);
    setReleases(res.data?.deploChangelog?.releases ?? []);
    setListError(res.data?.deploChangelog?.error ?? null);
  }, []);

  // On the stop, the newer release is offered by itself as soon as the last server connects.
  const waiting = Boolean(info?.stop?.waiting);
  React.useEffect(() => {
    if (!active || !waiting || updating) return;
    const timer = setInterval(() => void load(), WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [active, waiting, updating, load]);

  // The Advanced tab flips canary; the next visit here reads the versions it now offers.
  React.useEffect(() => {
    loaded.current = false;
  }, [canary]);

  React.useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    void load();
  }, [active, canary, load]);

  async function check() {
    setChecking(true);
    try {
      const res = await gqlAction(/* GraphQL */ `
        mutation CheckForUpdates {
          checkForUpdates {
            current
          }
        }
      `);
      if (!res.ok) {
        setInfo((i) => (i ? { ...i, error: res.error } : i));
        return;
      }
      await load();
    } finally {
      setChecking(false);
    }
  }

  React.useEffect(() => {
    if (!updating) return;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    let stop = false;
    const poll = async () => {
      const res = await gqlAction<
        {
          instanceSettings: { version: string };
          updateInfo: { lastRefusedUpdate: { at: string | null } | null };
        },
        { version: string; refusedAt: string | null }
      >(
        /* GraphQL */ `
          query RunningVersion {
            instanceSettings {
              version
            }
            updateInfo {
              lastRefusedUpdate {
                at
              }
            }
          }
        `,
        undefined,
        (d) => ({
          version: d.instanceSettings.version,
          refusedAt: d.updateInfo?.lastRefusedUpdate?.at ?? null,
        }),
      );
      if (stop) return;
      // Back on a new version, or back on the old one with a new rollback to explain.
      if (
        res.ok &&
        res.data &&
        (res.data.version !== version ||
          res.data.refusedAt !== refusedAt.current)
      ) {
        window.location.reload();
        return;
      }
      if (Date.now() - startedAt > UPDATE_TIMEOUT_MS) {
        setStalled(true);
        return;
      }
      timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 10_000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [updating, version]);

  async function startUpdate() {
    setManual(null);
    setStalled(false);
    refusedAt.current = info?.lastRefusedUpdate?.at ?? null;
    const res = await gqlAction<
      { updateDeplo: { version: string; logPath: string } },
      { version: string; logPath: string }
    >(
      /* GraphQL */ `
        mutation UpdateDeplo {
          updateDeplo {
            version
            logPath
          }
        }
      `,
      undefined,
      (d) => d.updateDeplo,
    );
    if (!res.ok) setManual(res.error);
    else if (res.data) setUpdating(res.data);
    return res;
  }

  const checkNow = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={check}
      disabled={checking}
    >
      <RefreshCw className={checking ? "size-4 animate-spin" : "size-4"} />
      {checking ? "Checking" : "Check now"}
    </Button>
  );

  if (releases === null) return <UpdatesSkeleton />;

  const hero = heroState({
    info,
    version,
    updating,
    stalled,
    manual,
    fleet,
    error: listError,
  });

  const refused = info?.lastRefusedUpdate ?? null;
  const stop = info?.stop ?? null;
  const extras =
    (manual && !updating) ||
    refused !== null ||
    (stop !== null && stopListsServers(stop)) ||
    fleet.behind.length > 0 ||
    fleet.pausedBy !== null;

  return (
    <UpdatesLayout>
      <Card>
        <CardContent className={STATUS_ROW}>
          <div className="min-w-0 flex-1">
            <h2 className={STATUS_TITLE}>
              {HERO_ICON[hero.tone]}
              <span className="min-w-0">
                {hero.title}
                {hero.tone === "new" && (
                  <InfoTip
                    className="ml-1.5 align-middle"
                    content="Deplo saves a copy of its database first, keeps every setting, and puts the old version back if the new one fails."
                    docs="upgrade.overview"
                  />
                )}
              </span>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{hero.line}</p>
          </div>
          {(!updating || stalled) && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {info?.updateAvailable && info.next && (
                <ConfirmAction
                  variant="default"
                  title={
                    fleet.total > 0
                      ? `Update Deplo to ${info.next}, then its ${fleet.total} server${fleet.total === 1 ? "" : "s"}?`
                      : `Update Deplo to ${info.next}?`
                  }
                  description={
                    <>
                      The machine Deplo runs on pulls the new version and
                      restarts the panel. It takes about a{" "}
                      <strong>minute</strong>.
                    </>
                  }
                  consequence="The dashboard is unreachable while it restarts. Deployed apps, sites and databases keep running."
                  extra={
                    <StrandedServers servers={info.strandedServers ?? []} />
                  }
                  confirmLabel="Update"
                  trigger={
                    <Button size="sm">
                      <CircleFadingArrowUp className="size-4" />
                      Update
                    </Button>
                  }
                  onConfirm={startUpdate}
                />
              )}
              {checkNow}
            </div>
          )}
        </CardContent>
        {extras && (
          <div className="space-y-3 border-t border-border p-5">
            {refused && <RefusedUpdateNotice refused={refused} />}
            {stop && <StopServers stop={stop} onLeft={load} />}
            {manual && !updating && <ManualUpdate />}
            <FleetBehind fleet={fleet} onSettled={refreshFleet} />
          </div>
        )}
      </Card>

      <section className="space-y-3">
        <h2 className={titleClass.section}>What changed</h2>
        <Changelog releases={releases} error={listError} />
      </section>
    </UpdatesLayout>
  );
}

// The illustration follows the page down on wide screens, beside the status and the changelog.
function UpdatesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_clamp(24rem,30vw,36rem)] xl:gap-12">
      <div className="relative order-first flex justify-center xl:sticky xl:top-24 xl:order-last xl:self-start">
        <UpdateGraphic grid className="w-48 xl:w-[72%]" />
      </div>
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  );
}

const UPDATE_TIMEOUT_MS = 10 * 60_000;
const WAITING_POLL_MS = 15_000;

const STATUS_ROW =
  "flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between";
const STATUS_TITLE =
  "flex items-center gap-2.5 text-2xl font-semibold tracking-tight";

type HeroTone = "ok" | "new" | "busy" | "warn";

const HERO_ICON: Record<HeroTone, React.ReactNode> = {
  ok: <CheckCircle2 className="size-6 shrink-0 text-success" />,
  new: <CircleFadingArrowUp className="size-6 shrink-0 text-info" />,
  busy: (
    <Loader2 className="size-6 shrink-0 animate-spin text-muted-foreground" />
  ),
  warn: <TriangleAlert className="size-6 shrink-0 text-warning" />,
};

// The panel and the fleet read as one answer: the first thing that needs a look wins.
export function heroState({
  info,
  version,
  updating,
  stalled,
  manual,
  fleet,
  error,
}: {
  info: UpdateInfo | null;
  version: string;
  updating: { version: string; logPath: string } | null;
  stalled: boolean;
  manual: string | null;
  fleet: FleetSummary;
  error: string | null;
}): { tone: HeroTone; title: string; line: string } {
  if (updating && stalled)
    return {
      tone: "warn",
      title: "The update did not take",
      line: `Deplo is still on v${version}. The machine wrote the run to ${updating.logPath}.`,
    };
  if (updating)
    return {
      tone: "busy",
      title: `Updating to v${updating.version}`,
      line: "This page reloads itself when Deplo is back.",
    };
  if (manual)
    return {
      tone: "warn",
      title: "Deplo could not update itself",
      line: manual,
    };
  if (!info || info.error)
    return {
      tone: "warn",
      title: "Couldn't check for updates",
      line: info?.error ?? error ?? "The release history did not load.",
    };
  if (info.updateAvailable && info.next)
    return {
      tone: "new",
      title: `Deplo ${info.next} is available`,
      line:
        info.nextIsStop && info.stop
          ? info.stop.reason
          : `You're on v${version}.`,
    };
  if (info.stop)
    return info.stop.waiting
      ? {
          tone: "busy",
          title: `Getting ready for Deplo ${info.latest}`,
          line: info.stop.reason,
        }
      : {
          tone: "warn",
          title: `Deplo ${info.latest} can't be installed yet`,
          line: info.stop.reason,
        };
  if (fleet.behind.length > 0) {
    const stuck =
      fleet.pausedBy !== null || fleet.behind.some((s) => s.update?.failed);
    const one = fleet.total === 1;
    return {
      tone: stuck ? "warn" : "busy",
      title: stuck ? "A server needs attention" : "Updating your servers",
      line: `${fleet.total - fleet.behind.length} of ${fleet.total} server${one ? " is" : "s are"} on the latest version.`,
    };
  }
  if (!info.canary && version.includes("-"))
    return {
      tone: "ok",
      title: "You're on a canary",
      line: `v${version}. The next stable version shows up here.`,
    };
  return {
    tone: "ok",
    title: "Deplo is up to date",
    line: `You're on v${version}.`,
  };
}

export function UpdatesSkeleton() {
  return (
    <div role="status" aria-busy aria-label="Loading updates">
      <UpdatesLayout>
        <Card>
          <CardContent className={STATUS_ROW}>
            <div className="min-w-0 flex-1">
              <div className={STATUS_TITLE}>
                <Skeleton className="size-6 rounded-full" />
                <TextLine className="w-64" />
              </div>
              <TextLine type="mt-1 text-sm leading-[1.6]" className="w-32" />
            </div>
            <Skeleton className="h-8 w-[106px] shrink-0" />
          </CardContent>
        </Card>

        <section className="space-y-3">
          <TextLine type={titleClass.section} className="w-28" />
          <ChangelogSkeleton />
        </section>
      </UpdatesLayout>
    </div>
  );
}

// Offline servers the new version refuses: they cannot update until they come back.
function StrandedServers({
  servers,
}: {
  servers: NonNullable<UpdateInfo["strandedServers"]>;
}) {
  if (servers.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm">
      {servers.map((s) => (
        <li key={s.id} className="flex items-start gap-1.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
          <span>
            <strong>{s.name}</strong> is offline
            {s.version ? ` on server agent v${s.version}` : ""} and will be
            unusable until its server agent updates.
          </span>
        </li>
      ))}
    </ul>
  );
}

const stopListsServers = (stop: UpdateStop) =>
  stop.waiting &&
  (stop.waitingOn?.length ?? 0) + (stop.leftBehind?.length ?? 0) > 0;

// What the update stop still waits on: an instance admin can leave a server behind (ADR-0041).
export function StopServers({
  stop,
  onLeft,
}: {
  stop: UpdateStop;
  onLeft: () => void;
}) {
  if (!stopListsServers(stop)) return null;
  return (
    <ul className="space-y-2 text-sm">
      {stop.waitingOn?.map((s) => (
        <li key={s.id} className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 items-start gap-1.5">
            <Hourglass className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <strong>{s.name}</strong> hasn&apos;t connected to Deplo yet.
              Check that it&apos;s turned on and connected to the internet.
            </span>
          </span>
          <LeaveBehind server={s} onLeft={onLeft} />
        </li>
      ))}
      {stop.leftBehind?.map((s) => (
        <li key={s.id} className="flex items-start gap-1.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            <strong>{s.name}</strong> was left behind: it needs its server agent
            reinstalled after the update.{" "}
            <Link
              href={`/settings/servers/${s.id}`}
              className="text-foreground underline underline-offset-4"
            >
              Manage
            </Link>
          </span>
        </li>
      ))}
    </ul>
  );
}

function LeaveBehind({
  server,
  onLeft,
}: {
  server: StopServer;
  onLeft: () => void;
}) {
  return (
    <ConfirmAction
      title={`Leave ${server.name} behind?`}
      description={
        <>
          Deplo stops waiting for <strong>{server.name}</strong> to connect. Its
          apps and settings stay in Deplo.
        </>
      }
      consequence={`After the update, ${server.name} won't work until its server agent is reinstalled.`}
      confirmLabel="Leave behind"
      trigger={
        <Button variant="outline" size="sm" className="shrink-0">
          Leave behind
        </Button>
      }
      onConfirm={async () => {
        const res = await gqlAction(
          /* GraphQL */ `
            mutation LeaveServerBehind($id: String!) {
              leaveServerBehind(id: $id) {
                next
              }
            }
          `,
          { id: server.id },
        );
        if (res.ok) onLeft();
        return res;
      }}
    />
  );
}

// Shown until an update succeeds (ADR-0041).
export function RefusedUpdateNotice({ refused }: { refused: RefusedUpdate }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0">
        <p className="font-medium">
          {refused.version
            ? `The update to Deplo ${refused.version} was rolled back`
            : "An update was rolled back"}
        </p>
        <p className="mt-1 text-muted-foreground">{refused.reason}</p>
      </div>
    </div>
  );
}

function ManualUpdate() {
  return (
    <div className="space-y-1.5">
      <CommandLine command={installOneLiner()} />
      <p className="text-xs text-muted-foreground">
        Run it on the machine that runs Deplo. Your apps keep running.
      </p>
    </div>
  );
}
