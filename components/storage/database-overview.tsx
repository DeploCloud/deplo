"use client";

import * as React from "react";
import { Server as ServerIcon, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { DatabaseConnectionString } from "@/components/storage/database-connection-string";
import { useDatabaseRuntime } from "@/components/storage/use-database-runtime";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import { timeAgo } from "@/lib/utils";
import { DB_NAMES, ENGINE_CREDS } from "@/components/storage/db-engines";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * The database detail Overview: the connection string as a click-to-reveal chip
 * (the same one the Variables page uses for a value), the create-only engine
 * facts, network/exposure, a LIVE data size and container summary from the
 * runtime poll, and the "provisioned before labels" callout that steers a
 * pre-labels database to Redeploy (so logs/console/runtime work).
 */
export function DatabaseOverview({
  db,
  serverName,
  canReveal,
}: {
  db: DatabaseDTO;
  serverName: string;
  /** The viewer holds `manage_infra` — the capability `revealConnection` needs. */
  canReveal: boolean;
}) {
  const status = useLiveDatabaseStatus(db.status);
  const runtime = useDatabaseRuntime(db.id, { enabled: status === "running" });
  const creds = ENGINE_CREDS[db.type];

  // A database the row calls running but the agent can't see any container for
  // was almost certainly provisioned before the deplo.* labels existed — the
  // agent's label check finds nothing. Redeploy stamps the labels.
  const needsRelabel =
    status === "running" &&
    !!runtime &&
    !runtime.unreachable &&
    runtime.total === 0;

  return (
    <div className="space-y-5">
      {needsRelabel && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
          <div>
            <p className="font-medium">Redeploy to enable live tools</p>
            <p className="text-muted-foreground">
              This database was created before live status, logs and the terminal
              were available. Click <strong className="font-medium text-foreground">Redeploy</strong>{" "}
              above to enable them — the data volume is preserved.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Connection string</p>
            <DatabaseConnectionString
              id={db.id}
              masked={db.connectionStringMasked}
              canReveal={canReveal}
            />
          </div>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Field label="Engine">
              {/* Engine display name, not the raw id — `capitalize` used to
                  render "Mysql · V8.4" (it title-cases the version's "v" too). */}
              <span>
                {DB_NAMES[db.type] ?? db.type} · v{db.version}
              </span>
            </Field>
            {creds.username && (
              <Field label="Username">
                <code className="font-mono text-xs">{db.username}</code>
              </Field>
            )}
            {creds.dbName && (
              <Field label="Database">
                <code className="font-mono text-xs">{db.dbName}</code>
              </Field>
            )}
            <Field label="Server">
              <span className="flex items-center gap-1">
                <ServerIcon className="size-3.5 text-muted-foreground" />
                {serverName}
              </span>
            </Field>
            <Field label="Endpoint">
              <code className="font-mono text-xs">
                {db.host}:{db.port}
              </code>
            </Field>
            <Field label="Exposure">
              {db.exposedPublicly && db.exposedPort ? (
                <span>Public · port {db.exposedPort}</span>
              ) : (
                <span className="text-muted-foreground">Internal only</span>
              )}
            </Field>
            <Field label="Created">{timeAgo(db.createdAt)}</Field>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
