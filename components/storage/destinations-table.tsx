"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Cloud,
  KeyRound,
  Lock,
  ScrollText,
  Server,
  ShieldOff,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusDot } from "@/components/shared/status-badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { OptimisticList } from "@/components/shared/optimistic-list";
import { selectableProps } from "@/components/shared/card-selection";
import { PendingRows } from "@/components/shared/pending-create";
import { DestinationSpaceCell } from "@/components/storage/destination-space";
import { downloadRecoveryKey } from "@/components/storage/recovery-key";
import {
  firstLine,
  useDestinationActions,
  type DestinationCardView,
} from "@/components/storage/destination-actions";
import { cn } from "@/lib/utils";
import { TimeAgo } from "@/components/shared/time-ago";

export function DestinationsTable({
  destinations,
  canManage,
  selected,
  onSelect,
}: {
  destinations: DestinationCardView[];
  canManage: boolean;
  /** Ids currently selected, so a row can paint itself picked. */
  selected: Set<string>;
  onSelect: (
    id: string,
    e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => boolean;
}) {
  return (
    <div className="rounded-xl border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Where</TableHead>
            <TableHead>Space</TableHead>
            <TableHead>Last test</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <OptimisticList>
            {destinations.map((dest) => (
              <DestinationRow
                key={dest.id}
                dest={dest}
                canManage={canManage}
                selected={selected.has(dest.id)}
                onSelect={onSelect}
              />
            ))}
          </OptimisticList>
          <PendingRows columns={6} />
        </TableBody>
      </Table>
    </div>
  );
}

function DestinationRow({
  dest,
  canManage,
  selected,
  onSelect,
}: {
  dest: DestinationCardView;
  canManage: boolean;
  selected: boolean;
  onSelect: (
    id: string,
    e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => boolean;
}) {
  const router = useRouter();
  const { openLog, menu, dialogs } = useDestinationActions({ dest, canManage });
  const isServer = dest.kind === "server";

  return (
    <TableRow
      {...selectableProps(dest.id, (e) => onSelect(dest.id, e))}
      className={cn(selected && "bg-primary/10 hover:bg-primary/10")}
    >
      <TableCell className="font-medium">
        <span className="flex items-center gap-2">
          <StatusDot status={dest.status} />
          <span className="truncate">{dest.name}</span>
          {/* The card's banners, as one icon each: a row cannot carry a
              paragraph, and a security warning that disappears when you switch
              view is a warning that gets lost. */}
          {!dest.encrypted && (
            <SimpleTooltip content="Backups here are not encrypted. Add this destination again to get an encrypted one.">
              <ShieldOff className="size-3.5 shrink-0 text-[var(--warning)]" />
            </SimpleTooltip>
          )}
          {dest.encrypted && canManage && !dest.recoveryKeySavedAt && (
            <SimpleTooltip content="The recovery key has never been downloaded. Click to save it outside Deplo.">
              <button
                type="button"
                aria-label="Download recovery key"
                onClick={() =>
                  void downloadRecoveryKey(dest.id).then(
                    (ok) => ok && router.refresh(),
                  )
                }
              >
                <KeyRound className="size-3.5 shrink-0 text-[var(--warning)]" />
              </button>
            </SimpleTooltip>
          )}
          {dest.lastTestError && canManage && (
            <SimpleTooltip content={firstLine(dest.lastTestError)}>
              <button
                type="button"
                aria-label="Open connection log"
                onClick={openLog}
              >
                <ScrollText className="size-3.5 shrink-0 text-destructive" />
              </button>
            </SimpleTooltip>
          )}
          {dest.encrypted && dest.recoveryKeySavedAt && (
            <SimpleTooltip content="Backups here are encrypted, and the recovery key has been saved.">
              <Lock className="size-3.5 shrink-0 text-muted-foreground" />
            </SimpleTooltip>
          )}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {isServer ? (
            <Server className="size-3.5 shrink-0" />
          ) : (
            <Cloud className="size-3.5 shrink-0" />
          )}
          {isServer ? "Server" : "S3"}
        </span>
      </TableCell>
      <TableCell className="max-w-[22rem] truncate font-mono text-xs text-muted-foreground">
        {dest.where}
      </TableCell>
      <TableCell className="text-xs">
        <DestinationSpaceCell dest={dest} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {dest.lastTestAt ? <TimeAgo at={dest.lastTestAt} /> : "Never"}
      </TableCell>
      <TableCell className="text-right">
        {menu}
        {dialogs}
      </TableCell>
    </TableRow>
  );
}
