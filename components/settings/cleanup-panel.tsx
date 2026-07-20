"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Brush, CalendarClock, Loader2, Server as ServerIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { gqlAction } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";
import type { CleanupPolicy, CleanupScopeId } from "@/lib/data/docker-cleanup";

const UPDATE_POLICY = /* GraphQL */ `
  mutation UpdateDockerCleanupPolicy($input: UpdateDockerCleanupPolicyInput!) {
    updateDockerCleanupPolicy(input: $input) {
      enabled
    }
  }
`;

const RUN_CLEANUP_NOW = /* GraphQL */ `
  mutation RunDockerCleanupNow($serverId: String!) {
    runDockerCleanupNow(serverId: $serverId) {
      id
      reclaimedBytes
    }
  }
`;

/**
 * The four scopes, in the allow-list's order — the same list the data layer and the
 * agent's proto enum carry, and just as CLOSED. There is no entry for container,
 * volume, network or `system` prune because those do not exist: on a Deplo host a
 * stopped app is a live app (it is started again by `compose start`, so its container
 * must survive) and a dangling volume may hold a database's files.
 *
 * Every scope here is safe to reclaim on demand — the agent's allow-list touches no
 * container, data volume or network — so "Clean up now" runs in one click with no
 * confirmation. The costliest case, `unused_app_images`, only forces a rebuild of an
 * image no container references (Deplo pushes to no registry); the newest image per
 * app always survives, and it is already swept right after every deploy.
 */
const SCOPES: {
  id: CleanupScopeId;
  label: string;
  info: React.ReactNode;
}[] = [
  {
    id: "build_cache",
    label: "Build cache",
    info: (
      <>
        The Docker daemon&apos;s BuildKit cache. Removing it costs nothing but a slower
        next build — no app, image or volume is touched.
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
        Abandoned buildkit volumes — often the biggest win on a full host. Removed
        only if it holds a <code>buildkitd.lock</code>, so your data is safe.
      </>
    ),
  },
  {
    id: "unused_app_images",
    label: "Unused app images",
    info: (
      <>
        Old images no container — running <em>or</em> stopped — references. Also swept
        right after each deploy. Removed ones come back only by rebuilding; the newest
        per app is always kept.
      </>
    ),
  },
];

export interface CleanupServerOption {
  id: string;
  name: string;
}

/** The policy as the form holds it — the numbers as text, so a half-typed field is a
 *  half-typed field and not a `NaN` (the bounds are clamped server-side anyway). */
interface PolicyForm {
  enabled: boolean;
  schedule: string;
  minAgeHours: string;
  keepImagesPerApp: string;
  scopes: CleanupScopeId[];
  excludedServerIds: string[];
}

function toForm(p: CleanupPolicy): PolicyForm {
  return {
    enabled: p.enabled,
    schedule: p.schedule,
    minAgeHours: String(p.minAgeHours),
    keepImagesPerApp: String(p.keepImagesPerApp),
    scopes: [...p.scopes],
    excludedServerIds: [...p.excludedServerIds],
  };
}

function sameForm(a: PolicyForm, b: PolicyForm): boolean {
  const set = (xs: string[]) => [...xs].sort().join(",");
  return (
    a.enabled === b.enabled &&
    a.schedule === b.schedule &&
    a.minAgeHours === b.minAgeHours &&
    a.keepImagesPerApp === b.keepImagesPerApp &&
    set(a.scopes) === set(b.scopes) &&
    set(a.excludedServerIds) === set(b.excludedServerIds)
  );
}

export function CleanupPanel({
  policy,
  servers,
}: {
  policy: CleanupPolicy;
  servers: CleanupServerOption[];
}) {
  const router = useRouter();
  const [saved, setSaved] = React.useState(policy);
  const [form, setForm] = React.useState(() => toForm(policy));
  const [saving, startSave] = React.useTransition();
  /** The server whose sweep is in flight — one at a time, and the button says so. */
  const [running, setRunning] = React.useState<string | null>(null);

  // A save ends in router.refresh(), which re-renders this tree with the PERSISTED
  // policy. Adopt it as the new baseline (the supported "adjust state during render"
  // pattern) or the form would keep reading dirty against the values it just saved.
  if (saved !== policy) {
    setSaved(policy);
    setForm(toForm(policy));
  }

  const dirty = !sameForm(form, toForm(policy));
  const nothingSelected = form.scopes.length === 0;

  function toggleScope(scope: CleanupScopeId, on: boolean) {
    setForm((f) => ({
      ...f,
      scopes: on ? [...f.scopes, scope] : f.scopes.filter((s) => s !== scope),
    }));
  }

  function toggleExcluded(serverId: string, excluded: boolean) {
    setForm((f) => ({
      ...f,
      excludedServerIds: excluded
        ? [...f.excludedServerIds, serverId]
        : f.excludedServerIds.filter((id) => id !== serverId),
    }));
  }

  function save() {
    startSave(async () => {
      const res = await gqlAction(UPDATE_POLICY, {
        input: {
          enabled: form.enabled,
          schedule: form.schedule.trim(),
          minAgeHours: Number(form.minAgeHours) || 0,
          keepImagesPerApp: Number(form.keepImagesPerApp) || 1,
          scopes: form.scopes,
          excludedServerIds: form.excludedServerIds,
        },
      });
      // The server rejects an unparseable cron rather than repairing it — surface that
      // message as it was written, it names the field and the fix.
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Docker cleanup policy saved");
      router.refresh();
    });
  }

  /**
   * Manual cleanup is one click, no confirmation: it reclaims exactly the SAVED
   * policy's scopes on this host now. Nothing here is destructive — the agent's
   * allow-list never prunes a container, a data volume or a network, so a stopped app,
   * its data and its network all survive; the worst case is a rebuild of an image no
   * container references. The RUN's own reclaimed total is toasted (a dry run would
   * only estimate), and the sweep lands in the history below either way.
   */
  async function runNow(server: CleanupServerOption) {
    setRunning(server.id);
    try {
      const res = await gqlAction<
        { runDockerCleanupNow: { reclaimedBytes: number } },
        number
      >(
        RUN_CLEANUP_NOW,
        { serverId: server.id },
        (d) => d.runDockerCleanupNow.reclaimedBytes,
      );
      // An unprovisioned host, an unreachable agent, an agent too old to know how to
      // clean up: each has its own message and each one names the next move.
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Reclaimed ${formatBytes(res.data ?? 0)} on ${server.name}`);
      router.refresh();
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <CalendarClock className="size-4" />
            Scheduled cleanup
            <InfoTip content="One schedule for the whole instance. It sweeps every server except the ones excluded below, so a server you add later is swept without anyone remembering to enable it." />
          </CardTitle>
          <Switch
            checked={form.enabled}
            onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
            aria-label="Run the cleanup on a schedule"
          />
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <FieldLabel
                htmlFor="cleanup-schedule"
                info={
                  <>
                    Standard 5-field cron expression, <strong>evaluated in UTC</strong> —
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
                info="Caches only: reclaim build cache, dangling images and leaked build volumes older than this. 0 turns the age filter off. App images don't age out — they follow the keep-count below."
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
                onChange={(e) =>
                  setForm((f) => ({ ...f, keepImagesPerApp: e.target.value }))
                }
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

          <div className="flex justify-end">
            <Button size="sm" onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save policy"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <ServerIcon className="size-4" />
            Servers
            <InfoTip content="Exclude a host from the scheduled sweep — “Clean up now” still works on it, because an operator standing in front of the button has already made that call." />
          </CardTitle>
        </CardHeader>
        <CardContent>
          {servers.length === 0 ? (
            <EmptyState
              icon={ServerIcon}
              title="No servers connected"
              description="Add a server before there is any Docker disk to reclaim."
            />
          ) : (
            <div className="space-y-2">
              {servers.map((server) => {
                const excluded = form.excludedServerIds.includes(server.id);
                return (
                  <div
                    key={server.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border p-3"
                  >
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">
                      {server.name}
                    </p>
                    <div className="flex items-center gap-2">
                      <FieldLabel
                        htmlFor={`cleanup-exclude-${server.id}`}
                        className="cursor-pointer text-xs font-normal text-muted-foreground"
                        info="Skip this host on the schedule above. It stays excluded until you turn this off — and “Clean up now” ignores it entirely."
                      >
                        Exclude from the daily cleanup
                      </FieldLabel>
                      <Switch
                        id={`cleanup-exclude-${server.id}`}
                        checked={excluded}
                        onCheckedChange={(v) => toggleExcluded(server.id, v)}
                      />
                    </div>
                    {/* Disabled while the form is dirty: a cleanup runs the SAVED policy,
                        so it would reclaim a different scope set than the checkboxes on
                        screen show. A wrapping span keeps the tooltip reachable — a
                        disabled button swallows pointer events. */}
                    <SimpleTooltip
                      content={
                        dirty
                          ? "Save the policy first — a cleanup runs the saved scopes, not the unsaved ones"
                          : nothingSelected
                            ? "Select at least one thing to reclaim"
                            : `Reclaim Docker disk on ${server.name} now`
                      }
                    >
                      <span tabIndex={0}>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runNow(server)}
                          disabled={
                            dirty || nothingSelected || running !== null || saving
                          }
                        >
                          {running === server.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Brush className="size-4" />
                          )}
                          Clean up now
                        </Button>
                      </span>
                    </SimpleTooltip>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
