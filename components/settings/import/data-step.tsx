"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, Database, HardDrive, Layers } from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The data cutover, service by service.
 *
 * Separate from the import steps because it happens at a different TIME: the
 * configuration lands whenever, the data moves the night someone is ready for
 * downtime. It is also the only destructive thing in this feature — it stops the
 * service on the old platform and does not start it again — so it asks, with the
 * volumes it is about to overwrite spelled out.
 */

interface DataVolume {
  sourceVolume: string;
  targetVolume: string;
  mountPath: string;
  note: string | null;
}

export interface DataService {
  path: string;
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  sourceServerId: string;
  targetKind: string;
  targetId: string;
  targetName: string;
  targetServerId: string;
  running: boolean;
  volumes: DataVolume[];
  notes: string[];
}

interface MoveResult {
  moved: number;
  failed: number;
  notes: string[];
}

const PLAN = /* GraphQL */ `
  mutation PlanDokployData($input: DokployConnectInput!) {
    planDokployDataMove(input: $input) {
      path
      sourceKind
      sourceId
      sourceName
      sourceServerId
      targetKind
      targetId
      targetName
      targetServerId
      running
      volumes {
        sourceVolume
        targetVolume
        mountPath
        note
      }
      notes
    }
  }
`;

const MOVE = /* GraphQL */ `
  mutation MoveDokployData(
    $input: DokployConnectInput!
    $runId: String!
    $sourceKind: String!
    $sourceId: String!
    $servers: [DokployServerChoiceInput!]
  ) {
    moveDokployServiceData(
      input: $input
      runId: $runId
      sourceKind: $sourceKind
      sourceId: $sourceId
      servers: $servers
    ) {
      moved
      failed
      notes
    }
  }
`;

/**
 * Read both sides and pair the volumes. Lives here next to its document, but is
 * CALLED by the wizard when the step is opened: a step transition is a click, and
 * loading from an effect would be a cascading render for no reason.
 */
export async function loadDataPlan(connectInput: {
  url: string;
  apiKey: string;
  allowPrivate: boolean;
}): Promise<DataService[] | null> {
  const res = await gqlAction<{ planDokployDataMove: DataService[] }, DataService[]>(
    PLAN,
    { input: connectInput },
    (d) => d.planDokployDataMove,
  );
  if (!res.ok) {
    toast.error(res.error);
    return null;
  }
  return res.data ?? [];
}

export function DataStep({
  connectInput,
  ensureRun,
  servers,
  serverMap,
  setServerMap,
  plan,
  loading,
  onReload,
}: {
  connectInput: { url: string; apiKey: string; allowPrivate: boolean };
  /** Open (or reuse) the run the copy's report lines are appended to. A cutover
   *  months after the import has no run in hand, and needing one is not a reason
   *  to send someone back through the wizard. */
  ensureRun: () => Promise<string | null>;
  servers: { id: string; name: string }[];
  /** Dokploy host id ("" for its own host) → Deplo server id. */
  serverMap: Record<string, string>;
  setServerMap: (v: Record<string, string>) => void;
  plan: DataService[] | null;
  loading: boolean;
  onReload: () => void;
}) {
  const [confirming, setConfirming] = React.useState<DataService | null>(null);
  const [moving, setMoving] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, MoveResult>>({});

  async function move(service: DataService) {
    setConfirming(null);
    setMoving(service.sourceId);
    const runId = await ensureRun();
    if (!runId) {
      setMoving(null);
      return;
    }
    const res = await gqlAction<
      { moveDokployServiceData: MoveResult },
      MoveResult
    >(
      MOVE,
      {
        input: connectInput,
        runId,
        sourceKind: service.sourceKind,
        sourceId: service.sourceId,
        servers: Object.entries(serverMap)
          .filter(([, to]) => to)
          .map(([from, to]) => ({ from, to })),
      },
      (d) => d.moveDokployServiceData,
    );
    setMoving(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    const result = res.data ?? { moved: 0, failed: 0, notes: [] };
    setResults((prev) => ({ ...prev, [service.sourceId]: result }));
    if (result.failed > 0) toast.error(`${result.failed} volume(s) did not copy`);
    else toast.success(`${result.moved} volume(s) copied into ${service.targetName}`);
  }

  const hosts = React.useMemo(() => {
    const ids = new Set((plan ?? []).map((s) => s.sourceServerId));
    return [...ids];
  }, [plan]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
          <CardTitle>Move the data</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            One service at a time. Moving a service stops it on Dokploy and does not
            start it again, then copies its volumes here.
          </p>
          </div>
          <Button variant="outline" size="sm" onClick={onReload} disabled={loading}>
            {loading ? "Reading" : "Refresh"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {hosts.length > 0 && (
            <div className="space-y-3 rounded-lg border p-3">
              <div>
                <div className="text-sm font-medium">Where the data lives now</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  The volumes are on the machine that runs them, so Deplo has to be
                  able to reach it. If Dokploy is on a machine Deplo does not manage,
                  add it as a server first.
                </p>
              </div>
              {hosts.map((h) => (
                <div key={h || "own"} className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm">
                    {h ? `Dokploy server ${h}` : "The Dokploy host"}
                  </span>
                  <Select
                    value={serverMap[h] ?? ""}
                    onValueChange={(v) => setServerMap({ ...serverMap, [h]: v })}
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue placeholder="Choose a server" />
                    </SelectTrigger>
                    <SelectContent>
                      {servers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}

          {loading && plan == null && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          )}

          {plan != null && plan.length === 0 && (
            <EmptyState
              icon={HardDrive}
              title="Nothing to move"
              description="No imported service on that Dokploy instance has a named volume, or the names no longer match on both sides."
            />
          )}

          {(plan ?? []).map((s) => (
            <ServiceRow
              key={s.sourceId}
              service={s}
              result={results[s.sourceId]}
              moving={moving === s.sourceId}
              disabled={moving != null || !serverMap[s.sourceServerId]}
              onMove={() => setConfirming(s)}
            />
          ))}
        </CardContent>
      </Card>

      <ConfirmDialog
        service={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={move}
      />
    </div>
  );
}

function ServiceRow({
  service,
  result,
  moving,
  disabled,
  onMove,
}: {
  service: DataService;
  result: MoveResult | undefined;
  moving: boolean;
  disabled: boolean;
  onMove: () => void;
}) {
  const Icon = service.targetKind === "database" ? Database : Layers;
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{service.sourceName}</div>
            <p className="mt-1 text-xs text-muted-foreground">{service.path}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {service.running && <Badge variant="outline">Running on Dokploy</Badge>}
          {result ? (
            <Badge variant={result.failed > 0 ? "destructive" : "secondary"}>
              {result.failed > 0
                ? `${result.failed} failed`
                : `${result.moved} copied`}
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={onMove}
              disabled={disabled || moving || service.volumes.length === 0}
            >
              {moving ? "Copying" : "Move the data"}
            </Button>
          )}
        </div>
      </div>

      {service.volumes.length > 0 && (
        <ul className="mt-2 space-y-1">
          {service.volumes.map((v) => (
            <li key={v.sourceVolume} className="text-xs text-muted-foreground">
              <code>{v.mountPath}</code> {v.sourceVolume} into {v.targetVolume}
              {v.note && <span className="ml-1 text-amber-600 dark:text-amber-400">{v.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {service.volumes.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">No volume to move.</p>
      )}
      {[...service.notes, ...(result?.notes ?? [])].map((n, i) => (
        <p key={i} className="mt-1 text-xs text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}

function ConfirmDialog({
  service,
  onCancel,
  onConfirm,
}: {
  service: DataService | null;
  onCancel: () => void;
  onConfirm: (s: DataService) => void;
}) {
  return (
    <Dialog open={service != null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        {service && (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              onConfirm(service);
            }}
          >
            <DialogHeader>
              <DialogTitle>Move {service.sourceName}&apos;s data</DialogTitle>
            </DialogHeader>

            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                This stops {service.sourceName} on Dokploy and does not start it
                again. Deplo needs it stopped to copy a volume that is not changing
                underneath.
              </p>
            </div>

            <div className="space-y-1 text-sm">
              {service.volumes.map((v) => (
                <div key={v.sourceVolume}>
                  <code className="text-xs">{v.mountPath}</code>
                  <div className="text-xs text-muted-foreground">
                    {v.sourceVolume} overwrites {v.targetVolume}
                  </div>
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit">Stop and copy</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
