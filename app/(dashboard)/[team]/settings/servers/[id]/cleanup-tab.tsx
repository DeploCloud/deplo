"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Brush, CalendarClock, Loader2, Server } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  CleanupHistory,
  cleanupSummary,
} from "@/components/settings/cleanup-history";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { SchedulePicker } from "@/components/shared/schedule-picker";
import { Badge } from "@/components/ui/badge";
import { gqlAction, gqlSubscribe } from "@/lib/graphql-client";
import { cn, formatBytes } from "@/lib/utils";
import type { CleanupPolicy } from "@/lib/data/docker-cleanup/policy";
import type { CleanupRunDTO } from "@/lib/data/docker-cleanup/run-history";
import type { CleanupScopeId } from "@/lib/data/docker-cleanup/scopes";
import type { ServerSummary } from "./server-detail-tabs";

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

const SCOPES: { id: CleanupScopeId; label: string; info: React.ReactNode }[] = [
  {
    id: "build_cache",
    label: "Build cache",
    info: (
      <>
        The Docker daemon&apos;s BuildKit cache, what makes a redeploy reuse the
        last build instead of repeating it. Removing it costs nothing but a
        slower next build; no app, image or volume is touched.
      </>
    ),
  },
  {
    id: "dangling_images",
    label: "Dangling images",
    info: (
      <>
        Untagged layers left by rebuilds. Anything a container references is
        never dangling, so a <strong>stopped</strong> app keeps the image it
        needs.
      </>
    ),
  },
  {
    id: "orphan_volumes",
    label: "Orphaned volumes",
    info: (
      <>
        Unused anonymous volumes, abandoned build caches and empty Deplo
        volumes. Named volumes containing app or workspace data are kept.
      </>
    ),
  },
  {
    id: "unused_app_images",
    label: "Unused app images",
    info: (
      <>
        Old images no container, running <em>or</em> stopped, references. Also
        swept right after each deploy. Removed ones come back only by
        rebuilding; the newest per app is kept, and a deleted app keeps none.
      </>
    ),
  },
  {
    id: "unused_pulled_images",
    label: "Unused pulled images",
    info: (
      <>
        Unused images with a registry reference. Locally built images and build
        tools are kept; a later deploy may need to download removed images
        again.
      </>
    ),
  },
  {
    id: "leftover_app_files",
    label: "Leftover app files",
    info: (
      <>
        The config files of apps and databases that were deleted. Judged against
        everything this Deplo still knows about, so a live app keeps its files
        even while it is moving between servers.
      </>
    ),
  },
  {
    id: "leftover_networks",
    label: "Leftover networks",
    info: (
      <>
        The networks of environments, previews and stacks that are gone. They
        take no disk, but each one holds a slice of the address range this
        server can hand out.
      </>
    ),
  },
];

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
  server: Pick<ServerSummary, "id" | "name">;
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
  const startedHere = React.useRef(new Set<string>());

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
        setRuns(next.filter((r) => r.serverId === server.id));
        for (const run of next) {
          if (run.status === "running" || !startedHere.current.has(run.id))
            continue;
          startedHere.current.delete(run.id);
          if (run.status === "failed") {
            toast.error(run.error || `Cleanup failed on ${run.serverName}`);
          } else {
            toast.success(
              run.reclaimedBytes === 0
                ? cleanupSummary(run)
                : `Reclaimed ${formatBytes(run.reclaimedBytes)} on ${run.serverName}`,
            );
          }
        }
      },
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
          },
        },
      );
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
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-4 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
              <Brush className="size-5 text-muted-foreground" />
            </span>
            <div>
              <CardTitle className="text-base">Reclaim disk now</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Free unused disk space. Your apps and their data stay untouched.
              </p>
            </div>
          </div>
          <SimpleTooltip
            content={
              sweeping
                ? `A cleanup is running on ${server.name}. It keeps going if you leave this page`
                : dirty
                  ? "Save the schedule first: a cleanup runs the saved scopes, not the unsaved ones"
                  : nothingSelected
                    ? "Select at least one thing to reclaim"
                    : `Reclaim disk on ${server.name} now`
            }
            side="bottom"
          >
            <span tabIndex={0} className="shrink-0">
              <Button
                onClick={runNow}
                disabled={dirty || nothingSelected || sweeping || saving}
              >
                {sweeping ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Brush className="size-4" />
                )}
                {sweeping ? "Cleaning up" : "Clean up now"}
              </Button>
            </span>
          </SimpleTooltip>
        </CardHeader>
      </Card>

      <Card>
        <SettingItem
          icon={Server}
          title="Include this server"
          description="This server follows the shared cleanup schedule."
          htmlFor="cleanup-included"
          control={
            <Switch
              id="cleanup-included"
              checked={included}
              onCheckedChange={setInclusion}
              disabled={saving}
              aria-label="Sweep this server on the schedule"
            />
          }
        />
      </Card>

      <form className="space-y-4" onSubmit={savePolicy}>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarClock className="size-4" />
                  Scheduled cleanup
                </CardTitle>
                <Badge variant="muted">All servers</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Changes here apply to every server.
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
                <FieldLabel
                  htmlFor="cleanup-enabled"
                  info="Turning this off pauses the schedule for all servers. To skip only this server, turn off Include this server."
                  docs="servers.cleanupSettings"
                  className="cursor-pointer"
                >
                  Enable schedule
                </FieldLabel>
                <Switch
                  id="cleanup-enabled"
                  checked={form.enabled}
                  onCheckedChange={(enabled) =>
                    setForm((f) => ({ ...f, enabled }))
                  }
                  aria-label="Enable scheduled cleanup on all servers"
                />
              </div>

              <SchedulePicker
                key={cleanup.policy.schedule}
                id="cleanup-schedule"
                value={form.schedule}
                onChange={(schedule) => setForm((f) => ({ ...f, schedule }))}
                timezone="UTC"
                docs="servers.cleanupSettings"
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="cleanup-min-age"
                    info="Minimum age for caches, dangling images, orphan volumes and unused registry images. App images follow rollback retention. 0 disables this age filter."
                    docs="servers.cleanupScopes"
                  >
                    Minimum age (hours)
                  </FieldLabel>
                  <Input
                    id="cleanup-min-age"
                    type="number"
                    min={0}
                    max={8760}
                    value={form.minAgeHours}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, minAgeHours: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="cleanup-keep-images"
                    info="For apps that can't be rolled back: a compose stack, a prebuilt image, a preview. A removed image comes back only by rebuilding."
                    docs="servers.cleanupScopes"
                  >
                    Images kept per app
                  </FieldLabel>
                  <Input
                    id="cleanup-keep-images"
                    type="number"
                    min={1}
                    max={20}
                    value={form.keepImagesPerApp}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        keepImagesPerApp: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Brush className="size-4" />
                What to reclaim
                <InfoTip
                  content="A cleanup reclaims only this list. Named volumes and anything a container still uses are never touched."
                  docs="servers.cleanupScopes"
                />
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Applies to scheduled and manual cleanups on all servers.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {SCOPES.map((scope) => {
                const selected = form.scopes.includes(scope.id);
                return (
                  <div
                    key={scope.id}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border border-border px-3 py-2.5",
                      selected && "bg-surface",
                    )}
                  >
                    <Checkbox
                      id={`cleanup-scope-${scope.id}`}
                      checked={selected}
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
                );
              })}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            The schedule and cleanup rules are shared by all servers
            <InfoTip
              content="One cleanup policy for the whole instance. Saving here updates every server, including ones you add later."
              docs="servers.cleanupSettings"
            />
          </span>
          <Button type="submit" disabled={saving || !dirty}>
            Save schedule
          </Button>
        </div>
      </form>

      <CleanupHistory runs={runs} hideServer />
    </div>
  );
}
