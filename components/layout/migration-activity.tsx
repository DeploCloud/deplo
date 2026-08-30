"use client";

import * as React from "react";
import Link from "next/link";
import { gqlSubscribe } from "@/lib/graphql-client";
import { MIGRATION_HEARTBEAT_STALE_MS } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/shared/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * The migration this team has in flight, live, for the whole shell.
 */
export type ActiveMigration = {
  id: string;
  sourceUrl: string;
  orgName: string | null;
  actor: string;
  startedAt: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  /**
   * The last thing the run touched, `Project / Environment / service`. The only
   * record of WHERE a run is that outlives the tab driving it - see the field's
   * own doc in the schema.
   */
  lastPath: string | null;
  /** `config` | `data` | `done` - the two halves count different things. */
  phase: string;
  doneSteps: number;
  totalSteps: number;
  stepLabel: string | null;
  /**
   * When the control plane driving this run last said it was alive - null while
   * nothing has picked it up.
   */
  heartbeatAt: string | null;
};

/**
 * Is anybody actually driving this run?
 */
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

export function MigrationActivityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [run, setRun] = React.useState<ActiveMigration | null>(null);

  React.useEffect(
    () =>
      gqlSubscribe<{ activeMigration: ActiveMigration | null }>(
        ACTIVE_MIGRATION_SUBSCRIPTION,
        undefined,
        (data) => setRun(data.activeMigration ?? null),
        // A stream we can no longer open stops decorating the header - never a
        // toast about a decoration.
        () => setRun(null),
      ),
    [],
  );

  return (
    <MigrationActivityContext.Provider value={run}>
      {children}
    </MigrationActivityContext.Provider>
  );
}

/** The team's running migration, or null when nothing is moving. */
export function useActiveMigration(): ActiveMigration | null {
  return React.useContext(MigrationActivityContext);
}

/**
 * The header's "hold off" sign. Not a link for somebody who cannot open that page:
 * the warning is for the whole team, the page is not.
 */
export function MigrationChip({ canOpen }: { canOpen: boolean }) {
  const run = useActiveMigration();
  if (!run) return null;

  // The chip IS the progress bar. It is the only thing on screen while somebody
  // is on another page, and "in progress" said for twenty minutes is the same
  // sentence whether the run is on its first project or its last.
  const pct =
    run.totalSteps > 0
      ? Math.min(100, Math.round((run.doneSteps / run.totalSteps) * 100))
      : 0;
  const counted = run.totalSteps > 0;
  // "Waiting" is not a smaller version of "in progress", it is a different
  // thing: nothing is happening, and the chip is the only place most of the team
  // will ever see that.
  const label = !isDriven(run)
    ? "Migration waiting"
    : counted
      ? `Migration ${Math.min(run.doneSteps + 1, run.totalSteps)}/${run.totalSteps}`
      : "Migration in progress";
  const body = (
    <>
      {/* Behind the text, not around it: a bar under a chip in a header is a
          second row of furniture, and the chip already has the shape of one. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-warning/30 transition-[width] duration-500"
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
        {/* What it is DOING, not a warning to stand still: the run finishes on
            the server now, so there is nothing to stay out of the way of except
            the apps it is still writing, and those refuse for themselves. */}
        {!isDriven(run)
          ? "No control plane has picked this migration up yet. It starts on its own within a minute or two."
          : run.stepLabel
            ? `${run.phase === "data" ? "Copying data" : "Importing"}: ${run.stepLabel}`
            : `${run.actor} is bringing a platform into this team.`}
      </TooltipContent>
    </Tooltip>
  );
}
