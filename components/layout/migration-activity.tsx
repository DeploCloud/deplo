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

  const label = "Migration in progress";
  const body = (
    <>
      <StatusDot status="building" />
      <span className="hidden sm:inline">{label}</span>
    </>
  );

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        {canOpen ? (
          <Badge variant="warning" asChild className="h-7 gap-1.5">
            <Link href="/settings/migrations" aria-label={label}>
              {body}
            </Link>
          </Badge>
        ) : (
          <Badge variant="warning" className="h-7 gap-1.5" aria-label={label}>
            {body}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {run.actor} is bringing a platform into this team. Best not to change
        anything until it finishes.
      </TooltipContent>
    </Tooltip>
  );
}
