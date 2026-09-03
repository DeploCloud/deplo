"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleFadingArrowUp,
  RefreshCw,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { RemoteMarkdown } from "@/components/shared/remote-markdown";
import { UpdateGraphic } from "@/components/settings/update-graphic";
import { gqlAction } from "@/lib/graphql-client";

/** How much of the fleet is on the agent release the control plane expects. */
export interface FleetSummary {
  total: number;
  outdated: number;
  expected: string;
}

type UpdateInfo = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  url: string | null;
  publishedAt: string | null;
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
};

const UPDATES_QUERY = /* GraphQL */ `
  query DeploUpdates {
    updateInfo {
      current
      latest
      updateAvailable
      url
      publishedAt
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
      }
    }
  }
`;

type UpdatesData = {
  updateInfo: UpdateInfo | null;
  deploChangelog: { error?: string | null; releases: Release[] } | null;
};

function day(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * Settings, Deplo -> Updates: what this instance runs, what the fleet runs, and
 * what changed in between.
 */
export function DeploUpdatesTab({
  active,
  version,
  fleet,
}: {
  active: boolean;
  version: string;
  fleet: FleetSummary;
}) {
  const [info, setInfo] = React.useState<UpdateInfo | null>(null);
  const [releases, setReleases] = React.useState<Release[] | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
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

  // The tab stays mounted across flips, so this is the FIRST activation only:
  // nobody who never opens Updates costs the instance a GitHub call.
  React.useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    void load();
  }, [active, load]);

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
      // The mutation expired the changelog's cache tag too, so re-read both.
      await load();
    } finally {
      setChecking(false);
    }
  }

  return (
    // Two columns only from `xl`: the picture takes what the window grew by, and
    // never squeezes the reading column. Same measure as the MCP wizard.
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_clamp(24rem,30vw,36rem)] xl:gap-12">
      {/* First in the DOM on a phone, where a picture on top reads as a heading;
          last and pinned on a wide screen, where it belongs on the right. */}
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
                  content="Deplo checks the official repository for new releases. Applying one is a command on the machine, never a button here."
                  docs="upgrade.overview"
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Verdict info={info} version={version} />
              <div className="flex flex-wrap items-center gap-2">
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
                {info?.updateAvailable && info.url && (
                  <Button size="sm" asChild>
                    <a
                      href={info.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View release
                    </a>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex w-fit items-center gap-2 text-base">
                <ServerIcon className="size-4" />
                Server agents
                <InfoTip
                  content="Every server runs a small agent Deplo talks to. They update one at a time, from each server's page."
                  docs="servers.overview"
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <FleetLine fleet={fleet} />
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings/servers">Open Servers</Link>
              </Button>
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
  const upToDate = fleet.total - fleet.outdated;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {fleet.outdated === 0 ? (
        <CheckCircle2 className="size-4 text-[var(--success)]" />
      ) : (
        <ArrowUpRight className="size-4 text-[var(--success)]" />
      )}
      <span className="font-medium">
        {upToDate} of {fleet.total}
      </span>
      on v{fleet.expected}
      {fleet.outdated > 0 && (
        <span className="text-muted-foreground">
          · {fleet.outdated} can be updated
        </span>
      )}
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
    return <div className="h-40 animate-pulse rounded-xl bg-muted/50" />;

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
      defaultValue={[releases[0].tag]}
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
              {r.prerelease && <Badge variant="muted">Pre-release</Badge>}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            {r.body ? (
              <RemoteMarkdown source={r.body} />
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
