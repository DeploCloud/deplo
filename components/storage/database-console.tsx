"use client";

import * as React from "react";
import { Database } from "lucide-react";
import { gqlAction } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { ConsoleEmpty, ConsolePane } from "@/components/console/console-pane";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import type { PaneTitle } from "@/components/shared/pane-title";
import type { ConsoleInstance } from "@/lib/data/console";
import type { DatabaseStatus } from "@/lib/types";

/**
 * A database's console — the same {@link ConsolePane} an App gets, pointed at the
 * database endpoints.
 */
export function DatabaseConsole({
  id,
  title,
  status: serverStatus,
  instances,
}: {
  id: string;
  title: PaneTitle;
  status: DatabaseStatus;
  instances: ConsoleInstance[];
}) {
  const status = useLiveDatabaseStatus(serverStatus);
  const running = status === "running";

  // Stable identities — the pane re-probes / re-binds when these change.
  const exec = React.useCallback(
    (command: string) =>
      gqlAction(
        `mutation($input: ExecDatabaseConsoleInput!){ execDatabaseConsole(input: $input) { output detach } }`,
        { input: { databaseId: id, command } },
        (d: { execDatabaseConsole: { output: string; detach?: boolean } }) =>
          d.execDatabaseConsole,
      ),
    [id],
  );

  const probeShell = React.useCallback(async () => {
    const res = await gqlAction(
      `query($databaseId: String!){ databaseShellLabel(databaseId: $databaseId) }`,
      { databaseId: id },
      (d: { databaseShellLabel: string | null }) => ({
        shell: d.databaseShellLabel,
      }),
    );
    return res.ok ? (res.data?.shell ?? null) : null;
  }, [id]);

  if (!running || instances.length === 0) {
    return (
      <ConsoleEmpty title={title}>
        <EmptyState
          icon={Database}
          title="Database is not running"
          description="Start the database, then come back to open a console in it."
        />
      </ConsoleEmpty>
    );
  }

  return (
    <ConsolePane
      id={id}
      title={title}
      instances={instances}
      initialName={instances[0].name}
      attachBase={`/api/databases/${encodeURIComponent(id)}/attach`}
      exec={exec}
      probeShell={probeShell}
    />
  );
}
