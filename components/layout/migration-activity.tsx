"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { gqlSubscribe } from "@/lib/graphql-client";
import { MIGRATION_HEARTBEAT_STALE_MS } from "@/lib/types/migration";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/shared/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type ActiveMigration = {
  id: string;
  status: string;
  sourceUrl: string;
  orgName: string | null;
  actor: string;
  startedAt: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  lastPath: string | null;
  phase: string;
  doneSteps: number;
  totalSteps: number;
  stepLabel: string | null;
  heartbeatAt: string | null;
};

export function isDriven(
  run: { heartbeatAt: string | null },
  now: number = Date.now(),
): boolean {
  if (!run.heartbeatAt) return false;
  const at = Date.parse(run.heartbeatAt);
  return !Number.isNaN(at) && now - at < MIGRATION_HEARTBEAT_STALE_MS;
}

const ACTIVE_MIGRATION_SUBSCRIPTION = /* GraphQL */ `
  subscription ActiveMigration {
    activeMigration {
      id
      status
      sourceUrl
      orgName
      actor
      startedAt
      created
      skipped
      failed
      manual
      lastPath
      phase
      doneSteps
      totalSteps
      stepLabel
      heartbeatAt
    }
  }
`;

const MigrationActivityContext = React.createContext<ActiveMigration | null>(
  null,
);

export function useMigrationFeed(
  teamId?: string,
  opts: { includeFinished?: boolean } = {},
): ActiveMigration | null {
  const [feed, setFeed] = React.useState<{
    teamId?: string;
    run: ActiveMigration | null;
  }>({ teamId, run: null });

  React.useEffect(
    () =>
      gqlSubscribe<{ activeMigration: ActiveMigration | null }>(
        ACTIVE_MIGRATION_SUBSCRIPTION,
        undefined,
        (data) => setFeed({ teamId, run: data.activeMigration ?? null }),
        () => setFeed({ teamId, run: null }),
        teamId ? { teamId } : undefined,
      ),
    [teamId],
  );

  const run = feed.teamId === teamId ? feed.run : null;
  return run && (opts.includeFinished || run.status === "running") ? run : null;
}

export function MigrationActivityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const run = useMigrationFeed(undefined, { includeFinished: true });

  return (
    <MigrationActivityContext.Provider value={run}>
      {children}
    </MigrationActivityContext.Provider>
  );
}

export function useActiveMigration(): ActiveMigration | null {
  return React.useContext(MigrationActivityContext);
}

export function MigrationChip({ canOpen }: { canOpen: boolean }) {
  const run = useActiveMigration();
  if (!run) return null;
  if (run.status !== "running")
    return <FinishedChip run={run} canOpen={canOpen} />;

  const pct =
    run.totalSteps > 0
      ? Math.min(100, Math.round((run.doneSteps / run.totalSteps) * 100))
      : 0;
  const counted = run.totalSteps > 0;
  const label = !isDriven(run)
    ? "Migration waiting"
    : counted
      ? `Migration ${Math.min(run.doneSteps + 1, run.totalSteps)}/${run.totalSteps}`
      : "Migration in progress";
  const body = (
    <>
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-warning-wash-strong transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
      <span className="relative flex items-center gap-1.5">
        <StatusDot status="building" />
        <span className="hidden sm:inline">{label}</span>
      </span>
    </>
  );

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        {canOpen ? (
          <Badge
            variant="warning"
            asChild
            className="relative h-7 gap-1.5 overflow-hidden"
          >
            <Link href="/settings/migrations" aria-label={label}>
              {body}
            </Link>
          </Badge>
        ) : (
          <Badge
            variant="warning"
            className="relative h-7 gap-1.5 overflow-hidden"
            aria-label={label}
          >
            {body}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {!isDriven(run)
          ? "No control plane has picked this migration up yet. It starts on its own within a minute or two."
          : run.stepLabel
            ? `${run.phase === "data" ? "Copying data" : "Importing"}: ${run.stepLabel}`
            : `${run.actor} is bringing a platform into this team.`}
      </TooltipContent>
    </Tooltip>
  );
}

function FinishedChip({
  run,
  canOpen,
}: {
  run: ActiveMigration;
  canOpen: boolean;
}) {
  const label = "Migration finished";
  const body = (
    <span className="flex items-center gap-1.5">
      <StatusDot status="success" />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
  const counts = `${run.created} created, ${run.failed} failed, ${run.manual} to finish by hand.`;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        {canOpen ? (
          <Badge variant="success" asChild className="h-7 gap-1.5">
            <Link href="/settings/migrations" aria-label={label}>
              {body}
            </Link>
          </Badge>
        ) : (
          <Badge variant="success" className="h-7 gap-1.5" aria-label={label}>
            {body}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {canOpen
          ? `${counts} Open the report; closing it clears this.`
          : counts}
      </TooltipContent>
    </Tooltip>
  );
}
