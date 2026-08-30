// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Server as ServerIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatabaseConnectionString } from "@/components/storage/database-connection-string";
import { DatabaseNetworkingCard } from "@/components/storage/database-networking-card";
import { DatabaseHealthStat } from "@/components/storage/database-health-stat";
import { BackupsStat } from "@/components/storage/database-stats";
import { timeAgoShort } from "@/lib/utils";
import { DB_NAMES, ENGINE_CREDS } from "@/components/storage/db-engines";
import type { DatabaseBackupSummary } from "@/lib/data/backups";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * The database Overview: what it is and how to reach it, side by side, with the
 * one control worth having here (publishing the port) inline.
 * https://deplo.build/docs/guides/data/databases
 */
export function DatabaseOverview({
  db,
  serverName,
  serverHost,
  canReveal,
  canConfigure,
  canExposePorts,
  canViewBackups,
  backups,
  dataStat,
}: {
  db: DatabaseDTO;
  serverName: string;
  serverHost: string;
  /** The viewer holds `reveal_secrets` - what `revealConnection` needs. */
  canReveal: boolean;
  canConfigure: boolean;
  canExposePorts: boolean;
  canViewBackups: boolean;
  backups: DatabaseBackupSummary;
  /** Streamed in its own boundary: measuring a volume walks it. */
  dataStat: React.ReactNode;
}) {
  const creds = ENGINE_CREDS[db.type];

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <DatabaseConnectionString
              id={db.id}
              masked={db.connectionStringMasked}
              canReveal={canReveal}
            />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Field label="Engine">
                {/* Display name, not the raw id - `capitalize` used to render
                    "Mysql · V8.4" (it title-cases the version's "v" too). */}
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
              <Field label="Created">{timeAgoShort(db.createdAt)}</Field>
            </dl>
          </CardContent>
        </Card>

        <DatabaseNetworkingCard
          db={db}
          serverHost={serverHost}
          canExposePorts={canExposePorts}
          canConfigure={canConfigure}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <DatabaseHealthStat id={db.id} status={db.status} />
        {dataStat}
        <BackupsStat
          summary={backups}
          href={
            canViewBackups ? `/storage/databases/${db.id}/backups` : undefined
          }
        />
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
