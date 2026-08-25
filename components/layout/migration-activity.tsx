"use client";

import * as React from "react";
import Link from "next/link";
import { gqlSubscribe } from "@/lib/graphql-client";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/shared/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * The migration this team has in flight, live, for the whole shell.
 *
 * A migration creates apps, databases and volumes across the fleet and stops
 * the services it moves on the source platform, so "one is running right now"
 * is something every member wants to see before they touch anything - not only
 * the person driving it, and not only on the migrations page. One SSE per tab,
 * shared by the header chip and by the wizard's watching panel.
 *
 * There is at most one: opening a run closes any older one of the same team.
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
};

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
 * The header's "hold off" sign. Amber and pulsing, like every other in-progress
 * state in the product, and it takes you straight to the migration itself.
 *
 * Not a link for somebody who cannot open that page: the warning is for the
 * whole team, the page is not.
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
  const label = counted
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
        {run.stepLabel
          ? `${run.phase === "data" ? "Copying data" : "Importing"}: ${run.stepLabel}`
          : `${run.actor} is bringing a platform into this team.`}
      </TooltipContent>
    </Tooltip>
  );
}
