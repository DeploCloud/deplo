"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { Label } from "@/components/ui/label";
import { gql, gqlAction } from "@/lib/graphql-client";

const SOURCE = /* GraphQL */ `
  query DataRecopySource($kind: String!, $id: String!) {
    dataRecopySource(kind: $kind, id: $id) {
      runId
      sourceUrl
      platform
      sourceKind
      sourceId
      sourceName
    }
  }
`;

const PLAN = /* GraphQL */ `
  query PlanRecopy($input: MigrationConnectInput!, $runId: String!) {
    planMigrationDataMove(input: $input, runId: $runId) {
      sourceId
      sourceName
      targetName
      running
      sourceReachable
      volumes {
        sourceVolume
        targetVolume
        mountPath
      }
      notes
    }
  }
`;

const MOVE = /* GraphQL */ `
  mutation MoveOneServiceData(
    $input: MigrationConnectInput!
    $runId: String!
    $sourceKind: String!
    $sourceId: String!
  ) {
    moveMigrationServiceData(
      input: $input
      runId: $runId
      sourceKind: $sourceKind
      sourceId: $sourceId
    ) {
      moved
      failed
      notes
    }
  }
`;

interface Source {
  runId: string;
  sourceUrl: string;
  platform: string;
  sourceKind: string;
  sourceId: string;
  sourceName: string;
}

interface PlanService {
  sourceId: string;
  sourceName: string;
  targetName: string;
  running: boolean;
  sourceReachable: boolean;
  volumes: {
    sourceVolume: string;
    targetVolume: string;
    mountPath: string;
  }[];
  notes: string[];
}

/**
 * Copy a workload's data over again, from the page where its absence is felt.
 *
 * The token is asked for because a run wipes it when it ends; everything else -
 * the panel, the service, the volumes - comes from the run's own report.
 */
export function RecopyDataDialog({
  open,
  onOpenChange,
  kind,
  id,
  name,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  kind: "app" | "database";
  id: string;
  name: string;
}) {
  const router = useRouter();
  // `undefined` while it is being read, `null` when nothing here came from a
  // migration. Kept apart so the effect below sets no state synchronously.
  const [source, setSource] = React.useState<Source | null | undefined>(
    undefined,
  );
  const [loading, setLoading] = React.useState(false);
  const [apiKey, setApiKey] = React.useState("");
  const [plan, setPlan] = React.useState<PlanService | null>(null);
  const [copying, setCopying] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    void gql<{ dataRecopySource: Source | null }>(SOURCE, { kind, id })
      .then((d) => alive && setSource(d.dataRecopySource))
      .catch((e: Error) => {
        if (alive) {
          setSource(null);
          toast.error(e.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [open, kind, id]);

  const panel = source?.platform === "coolify" ? "Coolify" : "Dokploy";
  const connect = source
    ? { url: source.sourceUrl, apiKey, kind: source.platform }
    : null;

  function readPlan(e: React.FormEvent) {
    e.preventDefault();
    if (!source || !apiKey.trim() || loading) return;
    setLoading(true);
    void gql<{ planMigrationDataMove: PlanService[] }>(PLAN, {
      input: connect,
      runId: source.runId,
    })
      .then((d) => {
        const mine = d.planMigrationDataMove.find(
          (s) => s.sourceId === source.sourceId,
        );
        if (!mine)
          toast.error(
            `${panel} has nothing left for ${source.sourceName}, so there is nothing to copy.`,
          );
        setPlan(mine ?? null);
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
  }

  function copy() {
    if (!source || copying) return;
    setCopying(true);
    void (async () => {
      const res = await gqlAction<
        { moveMigrationServiceData: { moved: number; failed: number } },
        { moved: number; failed: number }
      >(
        MOVE,
        {
          input: connect,
          runId: source.runId,
          sourceKind: source.sourceKind,
          sourceId: source.sourceId,
        },
        (d) => d.moveMigrationServiceData,
      );
      setCopying(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const { moved = 0, failed = 0 } = res.data ?? {};
      if (failed > 0)
        toast.error(
          `${failed} volume(s) did not come across. The migration's report says which.`,
        );
      else toast.success(`Copied ${moved} volume(s) into ${name}`);
      onOpenChange(false);
      router.refresh();
    })();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setApiKey("");
          setPlan(null);
          setSource(undefined);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy the data again</DialogTitle>
          <DialogDescription>
            {source
              ? `${source.sourceName} on ${source.sourceUrl} still holds this data. It is stopped there while the copy runs, and ${name} is stopped here.`
              : "Where this was imported from."}
          </DialogDescription>
        </DialogHeader>

        <AnimatedHeight
          className="grid grid-cols-[minmax(0,1fr)] gap-4"
          scroll={false}
        >
          {source === null ? (
            <p className="text-sm text-muted-foreground">
              {name} did not come from a migration, so there is nothing to copy
              again.
            </p>
          ) : null}

          {source && !plan ? (
            <form className="grid gap-4" onSubmit={readPlan}>
              <div className="space-y-2">
                <Label htmlFor="recopy-key">{panel} API token</Label>
                <Input
                  id="recopy-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoFocus
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Deplo wipes the token when a migration ends, so it needs it
                  again to read {source.sourceUrl}.
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!apiKey.trim() || loading}>
                  {loading ? <Loader2 className="size-4 animate-spin" /> : null}
                  Continue
                </Button>
              </DialogFooter>
            </form>
          ) : null}

          {plan ? (
            <div className="grid gap-4">
              <div className="space-y-1 text-sm">
                {plan.volumes.length === 0 ? (
                  <p className="text-muted-foreground">
                    {panel} says {plan.sourceName} mounts nothing, so there is
                    nothing to copy.
                  </p>
                ) : (
                  plan.volumes.map((v) => (
                    <div
                      key={`${v.sourceVolume}->${v.targetVolume}`}
                      className="flex items-baseline justify-between gap-3 font-mono text-xs"
                    >
                      <span className="truncate">{v.sourceVolume}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {v.mountPath}
                      </span>
                    </div>
                  ))
                )}
              </div>
              {!plan.sourceReachable && (
                <p className="flex items-start gap-2 text-sm text-[var(--warning)]">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  Deplo cannot reach the machine this data is on, so the copy
                  would not start. Check that server under Servers first.
                </p>
              )}
              {plan.notes.map((n) => (
                <p key={n} className="text-xs text-muted-foreground">
                  {n}
                </p>
              ))}
              <DialogFooter>
                <Button variant="outline" onClick={() => setPlan(null)}>
                  Back
                </Button>
                <Button
                  onClick={copy}
                  disabled={
                    copying ||
                    plan.volumes.length === 0 ||
                    !plan.sourceReachable
                  }
                >
                  {copying ? <Loader2 className="size-4 animate-spin" /> : null}
                  Copy
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </AnimatedHeight>
      </DialogContent>
    </Dialog>
  );
}
