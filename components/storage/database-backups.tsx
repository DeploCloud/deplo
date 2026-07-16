"use client";

import { Archive } from "lucide-react";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { CreateBackup } from "@/components/storage/create-backup";
import { BackupRow } from "@/components/storage/backup-row";
import type { BackupDTO } from "@/lib/data/backups";

type Destination = { id: string; name: string };

/**
 * The per-database Backups tab. Composes the existing team-wide storage backup
 * pieces — {@link CreateBackup} scoped to THIS database (its only target) and
 * {@link BackupRow} (which already carries Run now / Edit / Restore / Delete and
 * is database-aware) — rather than re-implementing them. The schedules are the
 * team's, pre-filtered to this database.
 */
export function DatabaseBackups({
  database,
  schedules,
  destinations,
}: {
  database: { id: string; name: string };
  schedules: BackupDTO[];
  destinations: Destination[];
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">Back up this database</h2>
          <p className="text-xs text-muted-foreground">
            Schedule a periodic dump of {database.name} to an S3 destination, then
            restore it from any run.
          </p>
        </div>
        {/* Scoped to this database: it's the only target option, so the create
            dialog opens straight onto it (no target toggle noise). */}
        <CreateBackup
          databases={[database]}
          services={[]}
          destinations={destinations}
        />
      </div>

      {schedules.length === 0 ? (
        <EmptyState
          icon={Archive}
          title="No backup schedules"
          description={
            destinations.length === 0
              ? "Add an S3 destination in Storage → S3 destinations first, then schedule a backup here."
              : "Schedule a backup to capture this database on a recurring basis."
          }
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Retention</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((s) => (
                <BackupRow key={s.id} backup={s} destinations={destinations} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
