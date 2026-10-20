"use client";

import * as React from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleFadingArrowUp,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { CommandLine } from "@/components/shared/code-block";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { installOneLiner } from "@/lib/install-script";
import { UpdateGraphic } from "@/components/settings/update-graphic";
import { gqlAction } from "@/lib/graphql-client";
import { Changelog, type Release } from "./deplo-changelog";
import {
  FleetAgentsCard,
  useFleetAgents,
  type FleetSummary,
} from "./fleet-agents-card";

export type { FleetSummary };

type UpdateInfo = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  publishedAt: string | null;
  canary: boolean;
  error?: string | null;
  strandedServers?: { id: string; name: string; version: string | null }[];
};

const UPDATES_QUERY = /* GraphQL */ `
  query DeploUpdates {
    updateInfo {
      current
      latest
      updateAvailable
      publishedAt
      canary
      error
      strandedServers {
        id
        name
        version
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
        { instanceSettings: { version: string } },
        string
      >(
        /* GraphQL */ `
          query RunningVersion {
            instanceSettings {
              version
            }
          }
        `,
        undefined,
        (d) => d.instanceSettings.version,
      );
      if (stop) return;
      if (res.ok && res.data && res.data !== version) {
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

  const allCurrent =
    !updating &&
    !manual &&
    info !== null &&
    !info.error &&
    !info.updateAvailable &&
    fleet.behind.length === 0;
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

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_clamp(24rem,30vw,36rem)] xl:gap-12">
      <div className="relative order-first flex justify-center xl:sticky xl:top-24 xl:order-last xl:self-start">
        <UpdateGraphic grid className="w-48 xl:w-[72%]" />
      </div>

      <div className="min-w-0 space-y-6">
        {allCurrent ? (
          <Card>
            <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <CheckCircle2 className="size-4 text-[var(--success)]" />
                  Everything is up to date
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Deplo v{version}
                  {fleet.total > 0 &&
                    ` - ${fleet.total} of ${fleet.total} server${fleet.total === 1 ? "" : "s"} on agent v${fleet.expected}`}
                </p>
              </div>
              <div className="shrink-0">{checkNow}</div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex w-fit items-center gap-2 text-base">
                  <CircleFadingArrowUp className="size-4" />
                  Control plane
                  <InfoTip
                    content="Deplo saves a copy of its database first, keeps every setting, and puts the old version back if the new one fails."
                    docs="upgrade.overview"
                  />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {updating ? (
                  <Updating
                    updating={updating}
                    stalled={stalled}
                    version={version}
                  />
                ) : (
                  <>
                    <Verdict info={info} version={version} />
                    {manual && <ManualUpdate reason={manual} />}
                  </>
                )}
                {(!updating || stalled) && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      {info?.updateAvailable && info.latest && (
                        <ConfirmAction
                          variant="default"
                          title={
                            fleet.total > 0
                              ? `Update Deplo to ${info.latest}, then its ${fleet.total} server${fleet.total === 1 ? "" : "s"}?`
                              : `Update Deplo to ${info.latest}?`
                          }
                          description={
                            <>
                              The machine Deplo runs on pulls the new version
                              and restarts the panel. It takes about a{" "}
                              <strong>minute</strong>.
                            </>
                          }
                          consequence="The dashboard is unreachable while it restarts. Deployed apps, sites and databases keep running."
                          extra={
                            <StrandedServers
                              servers={info.strandedServers ?? []}
                            />
                          }
                          confirmLabel="Update"
                          trigger={
                            <Button size="sm">
                              <CircleFadingArrowUp className="size-4" />
                              Update to {info.latest}
                            </Button>
                          }
                          onConfirm={startUpdate}
                        />
                      )}
                      {checkNow}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <FleetAgentsCard fleet={fleet} onSettled={refreshFleet} />
          </div>
        )}

        <section className="space-y-3">
          <h2 className="text-base font-semibold tracking-tight lg:text-lg">
            What changed
          </h2>
          <Changelog releases={releases} error={listError} />
        </section>
      </div>
    </div>
  );
}

const UPDATE_TIMEOUT_MS = 10 * 60_000;

function Updating({
  updating,
  stalled,
  version,
}: {
  updating: { version: string; logPath: string };
  stalled: boolean;
  version: string;
}) {
  if (stalled)
    return (
      <div className="space-y-1">
        <p className="flex items-start gap-1.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
          <span>Deplo is still on v{version}, so the update did not take.</span>
        </p>
        <p className="text-xs text-muted-foreground">
          The machine transcribed the run to {updating.logPath}.
        </p>
      </div>
    );
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        Updating to v{updating.version}
      </p>
      <p className="text-xs text-muted-foreground">
        This page reloads itself when Deplo is back.
      </p>
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
            <strong>{s.name}</strong> is offline on{" "}
            {s.version ? `v${s.version}` : "an unknown agent"} and will be
            unusable until its agent updates.
          </span>
        </li>
      ))}
    </ul>
  );
}

function ManualUpdate({ reason }: { reason: string }) {
  return (
    <div className="space-y-1.5">
      <p className="flex items-start gap-1.5 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <span>{reason}</span>
      </p>
      <CommandLine command={installOneLiner()} />
      <p className="text-xs text-muted-foreground">
        Run it on the machine that runs Deplo. Your apps keep running.
      </p>
    </div>
  );
}

function Verdict({
  info,
  version,
}: {
  info: UpdateInfo | null;
  version: string;
}) {
  if (!info)
    return (
      <p className="text-sm text-muted-foreground">
        Reading the release history
      </p>
    );
  if (info.error)
    return (
      <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <span>{info.error}</span>
      </p>
    );
  if (info.updateAvailable)
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <ArrowUpRight className="size-4 text-[var(--success)]" />
        <span className="font-medium">{info.latest}</span> is available
        <span className="text-muted-foreground">· you are on v{version}</span>
      </p>
    );
  if (!info.canary && version.includes("-"))
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <CheckCircle2 className="size-4 text-[var(--success)]" />
        You&apos;re on a canary
        <span className="font-mono text-muted-foreground">v{version}</span>
        <span className="text-muted-foreground">
          · the next stable version shows up here
        </span>
      </p>
    );
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <CheckCircle2 className="size-4 text-[var(--success)]" />
      You&apos;re on the latest version
      <span className="font-mono text-muted-foreground">v{version}</span>
    </p>
  );
}
