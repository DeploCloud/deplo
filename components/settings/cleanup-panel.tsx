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
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";
import type {
  CleanupPolicy,
  CleanupReport,
  CleanupScopeId,
} from "@/lib/data/docker-cleanup";

const UPDATE_POLICY = /* GraphQL */ `
  mutation UpdateDockerCleanupPolicy($input: UpdateDockerCleanupPolicyInput!) {
    updateDockerCleanupPolicy(input: $input) {
      enabled
    }
  }
`;

const PREVIEW_CLEANUP = /* GraphQL */ `
  mutation PreviewDockerCleanup($serverId: String!) {
    previewDockerCleanup(serverId: $serverId) {
      serverId
      serverName
      reclaimedBytes
      scopes {
        scope
        reclaimedBytes
        itemsRemoved
        skipped
        error
      }
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
 * `unit` names what the count counts, so the confirm dialog reads "5 volumes", not
 * "5 items". `risky` marks the one scope whose removal is not free: Deplo pushes to no
 * registry, so an app image that goes comes back only by a rebuild — that is what
 * makes the typed confirmation worth the friction.
 */
const SCOPES: {
  id: CleanupScopeId;
  label: string;
  unit: string;
  info: React.ReactNode;
  risky?: boolean;
}[] = [
  {
    id: "build_cache",
    label: "Build cache",
    unit: "records",
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
    unit: "images",
    info: (
      <>
        Untagged layers left behind by rebuilds. An image a container still references
        is never dangling, so a <strong>stopped</strong> app keeps the image it needs to
        start again.
      </>
    ),
  },
  {
    id: "orphan_buildkit_cache",
    label: "Orphaned build caches",
    unit: "volumes",
    info: (
      <>
        Abandoned buildkit volumes — usually the biggest win on a full host. A volume is
        removed only when the agent finds a <code>buildkitd.lock</code> inside it, so a
        dangling volume that holds your data is left alone.
      </>
    ),
  },
  {
    id: "unused_app_images",
    label: "Unused app images",
    unit: "images",
    risky: true,
    info: (
      <>
        Old app images that no container — running <em>or</em> stopped — references.
        Deplo pushes to no registry, so a removed image comes back only by rebuilding
        the app from source; the newest image per app is always kept (see “Images kept
        per app”).
      </>
    ),
  },
];

const SCOPE_META = new Map(SCOPES.map((s) => [s.id, s]));

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
  /** The server whose dry run is in flight — one at a time, and the button says so. */
  const [previewing, setPreviewing] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<CleanupReport | null>(null);

  // A save ends in router.refresh(), which re-renders this tree with the PERSISTED
  // policy. Adopt it as the new baseline (the supported "adjust state during render"
  // pattern) or the form would keep reading dirty against the values it just saved.
  if (saved !== policy) {
    setSaved(policy);
    setForm(toForm(policy));
  }

  const dirty = !sameForm(form, toForm(policy));
  const riskySelected = form.scopes.includes("unused_app_images");
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
   * Step one of the two-step manual cleanup: ask the agent what it WOULD reclaim
   * (a dry run — it removes nothing), then open the confirm dialog on the answer. The
   * operator approves a list of objects and a byte count, never a bare verb.
   */
  async function preview(server: CleanupServerOption) {
    setPreviewing(server.id);
    try {
      const res = await gqlAction<{ previewDockerCleanup: CleanupReport }, CleanupReport>(
        PREVIEW_CLEANUP,
        { serverId: server.id },
        (d) => d.previewDockerCleanup,
      );
      // An unprovisioned host, an unreachable agent, an agent too old to know how to
      // clean up: each has its own message and each one names the next move.
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.data) setReport(res.data);
    } finally {
      setPreviewing(null);
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
                info={
                  <>
                    Only reclaim objects older than this, so a build that finished
                    minutes ago keeps its cache. 0 turns the age filter off — and lets
                    the build-cache sweep clear <em>all</em> of it, not just the stale
                    part.
                  </>
                }
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
                info={
                  <>
                    Unused app images only: how many of the newest images to keep for
                    each app. Deplo pushes to no registry, so a removed image comes back
                    only by a rebuild — keep at least one.
                  </>
                }
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
            <FieldLabel info="What a sweep reclaims — scheduled or manual, it is this list. Everything outside it is left alone: containers, data volumes and networks are never pruned.">
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
                        so the preview would enumerate one scope set while the checkboxes
                        on screen show another. A wrapping span keeps the tooltip
                        reachable — a disabled button swallows pointer events. */}
                    <SimpleTooltip
                      content={
                        dirty
                          ? "Save the policy first — a cleanup runs the saved scopes, not the unsaved ones"
                          : nothingSelected
                            ? "Select at least one thing to reclaim"
                            : `Preview what would be reclaimed on ${server.name}`
                      }
                    >
                      <span tabIndex={0}>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => preview(server)}
                          disabled={
                            dirty || nothingSelected || previewing !== null || saving
                          }
                        >
                          {previewing === server.id ? (
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

      {/* Step two: the dialog only exists once a dry run has answered, so it can never
          ask an operator to approve a cleanup nobody has enumerated. */}
      {report && (
        <ConfirmAction
          open
          onOpenChange={(v) => {
            if (!v) setReport(null);
          }}
          title={`Clean up Docker on ${report.serverName}?`}
          description="This removes exactly what is listed below — nothing has been removed yet. Stopped apps, their data volumes and their networks are never touched."
          confirmLabel="Clean up now"
          // The typed gate is spent where it buys something: `unused_app_images` is the
          // one scope whose removal is not free (no registry, so a rebuild is the only
          // way back). Build cache and dangling layers do not warrant the friction, and
          // a confirmation asked for everything is a confirmation read for nothing.
          confirmText={riskySelected ? report.serverName : undefined}
          extra={<CleanupReportTable report={report} />}
          onConfirm={async () => {
            const res = await gqlAction<
              { runDockerCleanupNow: { reclaimedBytes: number } },
              number
            >(
              RUN_CLEANUP_NOW,
              { serverId: report.serverId },
              (d) => d.runDockerCleanupNow.reclaimedBytes,
            );
            if (res.ok) {
              // The RUN's own total, never the preview's: a dry run enumerates
              // candidates and the daemon can free a different number. ConfirmAction
              // would toast a static `successMessage` — that would be the estimate, so
              // toast the fact instead.
              toast.success(
                `Reclaimed ${formatBytes(res.data ?? 0)} on ${report.serverName}`,
              );
              router.refresh();
            }
            // A failure is toasted verbatim by ConfirmAction, and the run is already in
            // the history below as `failed` — the attempt is recorded either way.
            return res;
          }}
        />
      )}
    </div>
  );
}

/** The dry run's per-scope answer: what would go, how many, and how much it frees. */
function CleanupReportTable({ report }: { report: CleanupReport }) {
  const lines = report.scopes.filter(
    (s) => s.itemsRemoved > 0 || s.reclaimedBytes > 0 || s.skipped || s.error,
  );
  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
      {lines.length === 0 ? (
        <p className="text-muted-foreground">
          There is nothing to reclaim on this host right now.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {lines.map((line) => {
            const meta = SCOPE_META.get(line.scope);
            return (
              <li key={line.scope} className="space-y-0.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">
                    {meta?.label ?? line.scope}
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {line.itemsRemoved} {meta?.unit ?? "items"}
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatBytes(line.reclaimedBytes)}
                    </span>
                  </span>
                </div>
                {/* A skipped scope is not a failure: the agent declined the one thing it
                    could not prove was safe and will still sweep the rest. */}
                {line.skipped && (
                  <p className="text-xs text-muted-foreground">
                    Skipped — the agent could not prove this was safe to remove.
                  </p>
                )}
                {line.error && (
                  <p className="text-xs text-destructive">{line.error}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-baseline justify-between border-t border-border pt-2 font-medium">
        <span>Total reclaimed</span>
        <span className="tabular-nums">{formatBytes(report.reclaimedBytes)}</span>
      </div>
    </div>
  );
}
