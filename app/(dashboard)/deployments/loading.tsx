// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// The toolbar's five narrowers, at the widths their real SelectTriggers carry:
// Server, App, Status, Environment, Time.
const FACETS = [
  "w-[170px]",
  "w-[180px]",
  "w-[150px]",
  "w-[160px]",
  "w-[205px]",
];

// One tuple per placeholder row: the commit message width and the app name's,
// so the column doesn't read as a ruler.
const ROWS: [string, string][] = [
  ["w-52", "w-24"],
  ["w-40", "w-20"],
  ["w-60", "w-28"],
  ["w-36", "w-24"],
  ["w-48", "w-16"],
  ["w-56", "w-24"],
  ["w-44", "w-20"],
  ["w-64", "w-28"],
];

export default function Loading() {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading deployments"
    >
      {/* Header: title over subtitle, opposite the bulk-action slot. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>

      {/* Search, the five narrowers, and the sort pinned right. */}
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        <div className="w-full min-w-0 sm:w-64">
          <Skeleton className="h-9 w-full" />
        </div>
        <Skeleton className="size-4 shrink-0 rounded" />
        {FACETS.map((w) => (
          <Skeleton key={w} className={cn("h-9 shrink-0", w)} />
        ))}
        <Skeleton className="h-9 w-[150px] shrink-0 sm:ml-auto" />
      </div>

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10">
                <Skeleton className="size-4 rounded" />
              </TableHead>
              <TableHead>Deployment</TableHead>
              <TableHead>App</TableHead>
              <TableHead>Server</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Environment</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map(([message, app], i) => (
              <TableRow key={i} className="hover:bg-transparent">
                <TableCell>
                  <Skeleton className="size-4 rounded" />
                </TableCell>
                {/* Commit message over its sha */}
                <TableCell className="max-w-[280px]">
                  <Skeleton className={cn("h-4", message)} />
                  <Skeleton className="mt-1.5 h-3 w-16" />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-5 shrink-0 rounded-md" />
                    <Skeleton className={cn("h-3.5", app)} />
                  </div>
                </TableCell>
                <TableCell>
                  <Skeleton className="h-3.5 w-24" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-20 rounded-full" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-24 rounded-md" />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Skeleton className="size-3.5 shrink-0 rounded" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </TableCell>
                {/* Time ago over who deployed it */}
                <TableCell>
                  <Skeleton className="h-4 w-20" />
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Skeleton className="size-4 shrink-0 rounded-full" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Skeleton className="size-8 rounded-md" />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
