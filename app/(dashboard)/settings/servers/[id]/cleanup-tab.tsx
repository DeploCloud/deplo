"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Brush, CalendarClock, Loader2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CleanupHistory } from "@/components/settings/cleanup-history";
import { gqlAction, gqlSubscribe } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";
import type {
  CleanupPolicy,
  CleanupRunDTO,
  CleanupScopeId,
} from "@/lib/data/docker-cleanup";
import type { ServerSummary } from "./server-detail-tabs";

/**
 * The Cleanup tab: reclaiming Docker disk on THIS host.
 *
 * It used to be an instance-wide page of its own, which put the sweep one level
 * away from the thing it acts on: an operator looking at a full server had to
 * leave it, find the host in a fleet list, and press a button there. The policy
 * is still one row for the whole instance (there is exactly one schedule to
 * reason about, and a server added later cannot silently go un-swept), so the
 * schedule and the scopes are editable here and say plainly that they apply
 * everywhere; only the switch, the button and the history are about this host.
 *
 * A sweep is a BACKGROUND job: "Clean up now" returns as soon as the run is on
 * the record and the host keeps working detached, so the run row is the progress
 * indicator and it arrives live over the subscription (including the nightly
 * one, on a page nobody touched).
 */

const RUN_FIELDS = `
  id serverId serverName trigger actor status error reclaimedBytes
  startedAt finishedAt
  items { scope reclaimedBytes itemsRemoved skipped error }
`;

const CLEANUP_RUNS_SUBSCRIPTION = /* GraphQL */ `
  subscription DockerCleanupRuns {
    dockerCleanupRuns { ${RUN_FIELDS} }
  }
`;

/**
 * The four scopes, in the allow-list's order. The same list the data layer and the
 * agent's proto enum carry, and just as CLOSED. There is no entry for container,
 * volume, network or `system` prune because those do not exist: on a Deplo host a
 * stopped app is a live app (it is started again by `compose start`, so its container
 * must survive) and a dangling volume may hold a database's files.
 */
const SCOPES: { id: CleanupScopeId; label: string; info: React.ReactNode }[] = [
  {
    id: "build_cache",
    label: "Build cache",
    info: (
      <>
        The Docker daemon&apos;s BuildKit cache, what makes a redeploy reuse the last
        build instead of repeating it. Removing it costs nothing but a slower next
        build; no app, image or volume is touched.
      </>
    ),
  },
  {
    id: "dangling_images",
    label: "Dangling images",
    info: (
      <>
        Untagged layers left by rebuilds. Anything a container references is never
        dangling, so a <strong>stopped</strong> app keeps the image it needs.
      </>
    ),
  },
  {
    id: "orphan_buildkit_cache",
    label: "Orphaned build caches",
    info: (
      <>
        Abandoned buildkit volumes, often the biggest win on a full host. Removed
        only if it holds a <code>buildkitd.lock</code>, so your data is safe.
      </>
    ),
  },
  {
    id: "unused_app_images",
    label: "Unused app images",
    info: (
      <>
        Old images no container, running <em>or</em> stopped, references. Also swept
        right after each deploy. Removed ones come back only by rebuilding; the newest
        per app is always kept.
      </>
    ),
  },
];

/** The policy as the form holds it: the numbers as text, so a half-typed field is a
 *  half-typed field and not a `NaN` (the bounds are clamped server-side anyway). */
interface PolicyForm {
  enabled: boolean;
  schedule: string;
  minAgeHours: string;
  keepImagesPerApp: string;
  scopes: CleanupScopeId[];
}

function toForm(p: CleanupPolicy): PolicyForm {
  return {
    enabled: p.enabled,
    schedule: p.schedule,
    minAgeHours: String(p.minAgeHours),
    keepImagesPerApp: String(p.keepImagesPerApp),
    scopes: [...p.scopes],
  };
}

function sameForm(a: PolicyForm, b: PolicyForm): boolean {
  return (
    a.enabled === b.enabled &&
    a.schedule === b.schedule &&
    a.minAgeHours === b.minAgeHours &&
    a.keepImagesPerApp === b.keepImagesPerApp &&
    [...a.scopes].sort().join() === [...b.scopes].sort().join()
  );
}

export function ServerCleanupTab({
  server,
  cleanup,
}: {
  server: ServerSummary;
  cleanup: { policy: CleanupPolicy; runs: CleanupRunDTO[] };
}) {
  const router = useRouter();
  const [saved, setSaved] = React.useState(cleanup.policy);
  const [form, setForm] = React.useState(() => toForm(cleanup.policy));
  const [included, setIncluded] = React.useState(
    !cleanup.policy.excludedServerIds.includes(server.id),
  );
  const [saving, startSave] = React.useTransition();
  const [starting, setStarting] = React.useState(false);
  const [runs, setRuns] = React.useState(cleanup.runs);
  /** The runs THIS tab started, so only the admin who clicked gets the result
   *  toast. Not every other open page, and not the nightly sweep nobody asked for. */
  const startedHere = React.useRef(new Set<string>());

  // A save ends in router.refresh(), which re-renders this tree with the PERSISTED
  // policy. Adopt it as the new baseline (the supported "adjust state during render"
  // pattern) or the form would keep reading dirty against what it just saved.
  if (saved !== cleanup.policy) {
    setSaved(cleanup.policy);
    setForm(toForm(cleanup.policy));
    setIncluded(!cleanup.policy.excludedServerIds.includes(server.id));
    setRuns(cleanup.runs);
  }

  React.useEffect(() => {
    return gqlSubscribe<{ dockerCleanupRuns: CleanupRunDTO[] }>(
      CLEANUP_RUNS_SUBSCRIPTION,
      undefined,
      (data) => {
        const next = data.dockerCleanupRuns;
        if (!next) return;
        // The stream is instance-wide (one history, one fleet); this page is one
        // host, so it keeps its own rows and ignores the rest.
        setRuns(next.filter((r) => r.serverId === server.id));
        for (const run of next) {
          if (run.status === "running" || !startedHere.current.has(run.id)) continue;
          startedHere.current.delete(run.id);
          if (run.status === "failed") {
            toast.error(run.error || `Cleanup failed on ${run.serverName}`);
          } else {
            toast.success(`Reclaimed ${formatBytes(run.reclaimedBytes)} on ${run.serverName}`);
          }
        }
      },
      // A dropped stream self-heals (gqlSubscribe retries and the generator re-emits
      // the current snapshot), so a blip is not worth a toast.
      (e) => console.warn("[cleanup] live history stream error:", e.message),
    );
  }, [server.id]);

  const dirty = !sameForm(form, toForm(cleanup.policy));
  const nothingSelected = form.scopes.length === 0;
  const sweeping = starting || runs.some((r) => r.status === "running");

  function toggleScope(scope: CleanupScopeId, on: boolean) {
    setForm((f) => ({
      ...f,
      scopes: on ? [...f.scopes, scope] : f.scopes.filter((s) => s !== scope),
    }));
  }

  function savePolicy(e: React.FormEvent) {
    e.preventDefault();
    startSave(async () => {
      const res = await gqlAction(
        `mutation UpdateDockerCleanupPolicy($input: UpdateDockerCleanupPolicyInput!) {
          updateDockerCleanupPolicy(input: $input) { enabled }
        }`,
        {
          input: {
            enabled: form.enabled,
            schedule: form.schedule.trim(),
            minAgeHours: Number(form.minAgeHours) || 0,
            keepImagesPerApp: Number(form.keepImagesPerApp) || 1,
            scopes: form.scopes,
            // Deliberately absent: this page is one host, and sending the list
            // would rewrite every OTHER host's membership from a stale snapshot.
          },
        },
      );
      // The server rejects an unparseable cron rather than repairing it. Surface
      // that message as written, it names the field and the fix.
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Cleanup schedule saved");
      router.refresh();
    });
  }

  function setInclusion(next: boolean) {
    setIncluded(next);
    startSave(async () => {
      const res = await gqlAction(
        `mutation SetServerCleanupExcluded($serverId: String!, $excluded: Boolean!) {
          setServerCleanupExcluded(serverId: $serverId, excluded: $excluded) { enabled }
        }`,
        { serverId: server.id, excluded: !next },
      );
      if (!res.ok) {
        setIncluded(!next);
        toast.error(res.error);
        return;
      }
      toast.success(
        next
          ? `${server.name} is swept on the schedule`
          : `${server.name} is left out of the scheduled cleanup`,
      );
      router.refresh();
    });
  }

  /**
   * One click, no confirmation: it reclaims exactly the SAVED policy's scopes on
   * this host now. Nothing here is destructive: the agent's allow-list never
   * prunes a container, a data volume or a network. The click does NOT wait for
   * the host; what is toasted is "it started", and the total arrives later on the
   * run row, whether or not anyone is still looking at this page.
   */
  function runNow() {
    setStarting(true);
    startSave(async () => {
      const res = await gqlAction<{ runDockerCleanupNow: CleanupRunDTO }>(
        `mutation RunDockerCleanupNow($serverId: String!) {
          runDockerCleanupNow(serverId: $serverId) { ${RUN_FIELDS} }
        }`,
        { serverId: server.id },
      );
      setStarting(false);
      // Only pre-flight refusals reach here, an empty scope set, a sweep already
      // running on this host. Anything the HOST fails at lands on the run row.
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const run = res.data?.runDockerCleanupNow;
      if (run) {
        startedHere.current.add(run.id);
        setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      }
      toast.success(`Cleaning up ${server.name} in the background`);
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Brush className="size-4" />
            Reclaim disk now
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Frees build cache and unused images on this server. Your apps, their data
            and their networks are never touched.
          </p>
        </CardHeader>
        <CardContent>
          <SimpleTooltip
            content={
              sweeping
                ? `A cleanup is running on ${server.name}. It keeps going if you leave this page`
                : dirty
                  ? "Save the schedule first: a cleanup runs the saved scopes, not the unsaved ones"
                  : nothingSelected
                    ? "Select at least one thing to reclaim"
                    : `Reclaim Docker disk on ${server.name} now`
            }
            side="right"
          >
            {/* A wrapping span keeps the tooltip reachable: a disabled button
                swallows pointer events. */}
            <span tabIndex={0}>
              <Button onClick={runNow} disabled={dirty || nothingSelected || sweeping || saving}>
                {sweeping ? <Loader2 className="size-4 animate-spin" /> : <Brush className="size-4" />}
                {sweeping ? "Cleaning up" : "Clean up now"}
              </Button>
            </span>
          </SimpleTooltip>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex w-fit items-center gap-2 text-base">
              <CalendarClock className="size-4" />
              Scheduled cleanup
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Sweep this server automatically, so it never fills up unattended.
            </p>
          </div>
          <Switch
            checked={included}
            onCheckedChange={setInclusion}
            disabled={saving}
            aria-label="Sweep this server on the schedule"
          />
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={savePolicy}>
            <div className="flex items-center gap-2.5 rounded-lg border border-border p-3">
              <Checkbox
                id="cleanup-enabled"
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v === true }))}
              />
              <FieldLabel
                htmlFor="cleanup-enabled"
                className="cursor-pointer font-normal"
                info="One schedule for the whole instance, so turning it off here stops the sweep everywhere. To skip only this server, use the switch above."
              >
                Run the cleanup on a schedule (all servers)
              </FieldLabel>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="cleanup-schedule"
                  info={
                    <>
                      Standard 5-field cron expression, <strong>evaluated in UTC</strong> -
                      there is no per-server timezone. <code>0 4 * * *</code> is daily at
                      04:00 UTC.
                    </>
                  }
                >
                  Schedule
                </FieldLabel>
                <Input
                  id="cleanup-schedule"
                  value={form.schedule}
                  onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value }))}
                  className="font-mono text-xs"
                  placeholder="0 4 * * *"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="cleanup-min-age"
                  info="Caches only: reclaim build cache, dangling images and leaked build volumes older than this. 0 turns the age filter off. App images don't age out, they follow the keep-count next to this."
                >
                  Minimum age (hours)
                </FieldLabel>
                <Input
                  id="cleanup-min-age"
                  type="number"
                  min={0}
                  max={8760}
                  value={form.minAgeHours}
                  onChange={(e) => setForm((f) => ({ ...f, minAgeHours: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="cleanup-keep-images"
                  info="How many of the newest images to keep per app. Older ones are removed right after each deploy and by the sweep; a removed image comes back only by rebuilding."
                >
                  Images kept per app
                </FieldLabel>
                <Input
                  id="cleanup-keep-images"
                  type="number"
                  min={1}
                  max={20}
                  value={form.keepImagesPerApp}
                  onChange={(e) => setForm((f) => ({ ...f, keepImagesPerApp: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2.5">
              <FieldLabel info="Scheduled or manual, a sweep reclaims only this list. Containers, data volumes and networks are never pruned.">
                What to reclaim
              </FieldLabel>
              {SCOPES.map((scope) => (
                <div key={scope.id} className="flex items-center gap-2.5">
                  <Checkbox
                    id={`cleanup-scope-${scope.id}`}
                    checked={form.scopes.includes(scope.id)}
                    onCheckedChange={(v) => toggleScope(scope.id, v === true)}
                  />
                  <FieldLabel
                    htmlFor={`cleanup-scope-${scope.id}`}
                    info={scope.info}
                    className="cursor-pointer font-normal"
                  >
                    {scope.label}
                  </FieldLabel>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                The schedule and what it reclaims are shared by every server
                <InfoTip content="Deplo keeps one cleanup schedule for the whole instance, so a server you add later is swept without anyone remembering to enable it. Saving here changes it everywhere." />
              </span>
              <Button type="submit" disabled={saving || !dirty}>
                {saving ? "Saving" : "Save schedule"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <CleanupHistory runs={runs} hideServer />
    </>
  );
}
