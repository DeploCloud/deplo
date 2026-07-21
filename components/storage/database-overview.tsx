"use client";

import * as React from "react";
import { Eye, EyeOff, Server as ServerIcon, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { CopyButton } from "@/components/shared/copy-button";
import { gqlAction } from "@/lib/graphql-client";
import { useDatabaseRuntime } from "@/components/storage/use-database-runtime";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import { timeAgo } from "@/lib/utils";
import { DB_NAMES, ENGINE_CREDS } from "@/components/storage/db-engines";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * The database detail Overview: masked connection string with reveal + copy, the
 * create-only engine facts, network/exposure, a LIVE data size and container
 * summary from the runtime poll, and the "provisioned before labels" callout
 * that steers a pre-labels database to Redeploy (so logs/console/runtime work).
 */
export function DatabaseOverview({
  db,
  serverName,
}: {
  db: DatabaseDTO;
  serverName: string;
}) {
  const status = useLiveDatabaseStatus(db.status);
  const runtime = useDatabaseRuntime(db.id, { enabled: status === "running" });
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const creds = ENGINE_CREDS[db.type];

  // A database the row calls running but the agent can't see any container for
  // was almost certainly provisioned before the deplo.* labels existed — the
  // agent's label check finds nothing. Redeploy stamps the labels.
  const needsRelabel =
    status === "running" &&
    !!runtime &&
    !runtime.unreachable &&
    runtime.total === 0;

  function reveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    startTransition(async () => {
      const res = await gqlAction<{ revealConnection: string }, string>(
        `mutation($id: String!) { revealConnection(id: $id) }`,
        { id: db.id },
        (d) => d.revealConnection,
      );
      if (res.ok && res.data) setRevealed(res.data);
    });
  }

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
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Connection string</span>
              <button
                onClick={reveal}
                disabled={pending}
                className="flex cursor-pointer items-center gap-1 hover:text-foreground"
              >
                {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                {revealed ? "Hide" : "Reveal"}
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
                {revealed ?? db.connectionStringMasked}
              </code>
              {revealed && <CopyButton value={revealed} />}
            </div>
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
