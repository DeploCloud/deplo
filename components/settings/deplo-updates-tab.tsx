"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleFadingArrowUp,
  Loader2,
  RefreshCw,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";

import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { CommandLine } from "@/components/shared/code-block";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { installOneLiner } from "@/lib/install-script";
import { RemoteMarkdown } from "@/components/shared/remote-markdown";
import { UpdateGraphic } from "@/components/settings/update-graphic";
import { gqlAction } from "@/lib/graphql-client";

export interface FleetSummary {
  expected: string;
  total: number;
  behind: { id: string; name: string; version: string | null }[];
  updating: boolean;
}

type UpdateInfo = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  publishedAt: string | null;
  canary: boolean;
  error?: string | null;
};

type Release = {
  tag: string;
  name: string;
  url: string;
  publishedAt: string | null;
  body: string;
  prerelease: boolean;
  current: boolean;
  available: boolean;
};

const FLEET_QUERY = /* GraphQL */ `
  query FleetAgents {
    fleetAgents {
      expected
      total
      updating
      behind {
        id
        name
        version
      }
    }
  }
`;

const UPDATES_QUERY = /* GraphQL */ `
  query DeploUpdates {
    updateInfo {
      current
      latest
      updateAvailable
      publishedAt
      canary
      error
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

const POLL_MS = 10_000;
const POLL_TRIES = 30;

function useFleetAgents(seed: FleetSummary): FleetSummary {
  const [fleet, setFleet] = React.useState(seed);

  React.useEffect(() => {
    if (!fleet.updating) return;
    let stop = false;
    let tries = 0;
    const poll = async () => {
      const res = await gqlAction<{ fleetAgents: FleetSummary }, FleetSummary>(
        FLEET_QUERY,
        undefined,
        (d) => d.fleetAgents,
      );
      if (stop) return;
      if (res.ok && res.data) setFleet(res.data);
      if (++tries < POLL_TRIES) timer = setTimeout(poll, POLL_MS);
    };
    let timer = setTimeout(poll, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [fleet.updating]);

  return fleet;
}

function day(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

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
  const fleet = useFleetAgents(seed);
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

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_clamp(24rem,30vw,36rem)] xl:gap-12">
      <div className="relative order-first flex justify-center xl:sticky xl:top-24 xl:order-last xl:self-start">
        <UpdateGraphic className="w-48 xl:w-[72%]" />
      </div>

      <div className="min-w-0 space-y-6">
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
                            The machine Deplo runs on pulls the new version and
                            restarts the panel. It takes about a{" "}
                            <strong>minute</strong>.
                          </>
                        }
                        consequence="The dashboard is unreachable while it restarts. Deployed apps, sites and databases keep running."
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
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={check}
                      disabled={checking}
                    >
                      <RefreshCw
                        className={checking ? "size-4 animate-spin" : "size-4"}
                      />
                      {checking ? "Checking" : "Check now"}
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex w-fit items-center gap-2 text-base">
                <ServerIcon className="size-4" />
                Server agents
                <InfoTip
                  content="Every server runs a small agent. Deplo brings them to the panel's version by itself, one server at a time."
                  docs="servers.overview"
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <FleetLine fleet={fleet} />
              {fleet.behind.slice(0, BEHIND_SHOWN).map((server) => (
                <BehindLine
                  key={server.id}
                  server={server}
                  updating={fleet.updating}
                />
              ))}
              {fleet.behind.length > BEHIND_SHOWN && (
                <BehindDialog fleet={fleet} />
              )}
            </CardContent>
          </Card>
        </div>

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

function FleetLine({ fleet }: { fleet: FleetSummary }) {
  if (fleet.total === 0)
    return (
      <p className="text-sm text-muted-foreground">No servers connected yet.</p>
    );
  const upToDate = fleet.total - fleet.behind.length;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {fleet.behind.length === 0 ? (
        <CheckCircle2 className="size-4 text-[var(--success)]" />
      ) : (
        <ArrowUpRight className="size-4 text-[var(--success)]" />
      )}
      <span className="font-medium">
        {upToDate} of {fleet.total}
      </span>
      on v{fleet.expected}
    </p>
  );
}

const BEHIND_SHOWN = 3;

function BehindDialog({ fleet }: { fleet: FleetSummary }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="link" size="sm" className="h-auto p-0">
          Read more
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {fleet.behind.length} servers are behind v{fleet.expected}
          </DialogTitle>
          <DialogDescription>
            Deplo updates each of them on its own, and retries every 15 minutes.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {fleet.behind.map((server) => (
            <BehindLine
              key={server.id}
              server={server}
              updating={fleet.updating}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BehindLine({
  server,
  updating,
}: {
  server: FleetSummary["behind"][number];
  updating: boolean;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {updating ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <TriangleAlert className="size-4 text-[var(--warning)]" />
      )}
      <span className="font-medium">{server.name}</span>
      <span className="text-muted-foreground">
        {server.version ? `is on v${server.version}` : "has no agent version"}
      </span>
      <Link
        href={`/settings/servers/${server.id}`}
        className="text-foreground underline underline-offset-4"
      >
        Manage
      </Link>
    </p>
  );
}

function Changelog({
  releases,
  error,
}: {
  releases: Release[] | null;
  error: string | null;
}) {
  if (releases === null)
    return <div className="h-40 animate-pulse rounded-xl bg-surface-strong" />;

  if (releases.length === 0)
    return (
      <EmptyState
        graphic={<UpdateGraphic className="w-40" />}
        title={error ? "Couldn't read the release history" : "No releases yet"}
        description={
          error ??
          "Deplo publishes its release notes on GitHub. Nothing has been tagged so far."
        }
        docs="upgrade.releases"
      />
    );

  return (
    <Accordion
      type="multiple"
      defaultValue={releases
        .filter((r, i) => r.available || r.current || i === 0)
        .map((r) => r.tag)}
      className="rounded-xl border border-border px-4"
    >
      {releases.map((r) => (
        <AccordionItem key={r.tag} value={r.tag} className="last:border-b-0">
          <AccordionTrigger>
            <span className="flex flex-wrap items-center gap-2 text-left">
              <span className="font-mono text-sm font-medium">{r.tag}</span>
              {r.publishedAt && (
                <span className="text-xs text-muted-foreground">
                  {day(r.publishedAt)}
                </span>
              )}
              {r.current && <Badge variant="success">Installed</Badge>}
              {r.available && <Badge variant="info">Update available</Badge>}
              {r.prerelease && <Badge variant="muted">Canary</Badge>}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            {r.body ? (
              <ReleaseNotes source={r.body} />
            ) : (
              <p className="text-sm text-muted-foreground">
                This release shipped without notes.
              </p>
            )}
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex text-sm text-foreground underline underline-offset-4"
            >
              Open on GitHub
            </a>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

const NOTES_CLAMP_PX = 320;

function ReleaseNotes({ source }: { source: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [long, setLong] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > NOTES_CLAMP_PX + 48);
  }, [source]);

  const clamped = long && !expanded;
  return (
    <div>
      <div
        ref={ref}
        className="relative overflow-hidden"
        style={clamped ? { maxHeight: NOTES_CLAMP_PX } : undefined}
      >
        <RemoteMarkdown source={source} />
        {clamped && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-sm font-medium text-foreground underline underline-offset-4"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
