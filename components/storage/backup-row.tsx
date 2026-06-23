"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Play,
  Trash2,
  MoreHorizontal,
  RotateCcw,
  Database as DatabaseIcon,
  Boxes,
  Loader2,
} from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StatusDot } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { RestoreRunsDialog } from "@/components/storage/restore-runs-dialog";
import { timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { BackupDTO } from "@/lib/data/backups";

/** Menu-primitive set so the actions render once for both the ⋯ dropdown and the
 *  right-click context menu (see the note in project-card.tsx). */
type MenuKit = {
  Item: React.ElementType;
  Separator: React.ElementType;
};

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};
const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
};

export function BackupRow({ backup }: { backup: BackupDTO }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [restoreOpen, setRestoreOpen] = React.useState(false);

  const isProject = backup.targetKind === "project";
  const targetName = isProject ? backup.projectName : backup.databaseName;
  const targetId = isProject ? backup.projectId : backup.databaseId;

  function run() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!) { runBackup(id: $id) }`,
        { id: backup.id }
      );
      if (res.ok) {
        toast.success("Backup started");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function toggle(enabled: boolean) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $enabled: Boolean!) { toggleBackup(id: $id, enabled: $enabled) }`,
        { id: backup.id, enabled }
      );
      if (!res.ok) toast.error(res.error);
      else router.refresh();
    });
  }

  // Backup actions, rendered once for whichever menu primitive is passed. Each
  // item carries a native `title` so hovering it explains what it does. "Run now"
  // is disabled while a mutation is in flight; delete confirms before removing.
  const menu = (K: MenuKit) => (
    <>
      <K.Item onSelect={run} disabled={pending} title="Run this backup now">
        <Play className="size-4" />
        Run now
      </K.Item>
      <K.Item
        onSelect={(e: Event) => {
          e.preventDefault();
          setRestoreOpen(true);
        }}
        title="Restore from a recent backup"
      >
        <RotateCcw className="size-4" />
        Restore…
      </K.Item>
      <K.Separator />
      <K.Item
        variant="destructive"
        onSelect={(e: Event) => {
          e.preventDefault();
          setConfirmOpen(true);
        }}
        title="Delete this backup schedule"
      >
        <Trash2 className="size-4" />
        Delete
      </K.Item>
    </>
  );

  const row = (
    <TableRow onContextMenu={(e) => e.stopPropagation()}>
      <TableCell className="font-medium">{backup.name}</TableCell>
      <TableCell className="text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {isProject ? (
            <Boxes className="size-3.5 shrink-0" />
          ) : (
            <DatabaseIcon className="size-3.5 shrink-0" />
          )}
          {targetName ?? <span className="italic">deleted</span>}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {backup.destinationName}
      </TableCell>
      <TableCell>
        <code className="font-mono text-xs">{backup.schedule}</code>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {backup.retentionDays}d
      </TableCell>
      <TableCell>
        {backup.lastStatus === "never" ? (
          <span className="text-xs text-muted-foreground">Never run</span>
        ) : backup.lastStatus === "running" ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Running
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs">
            <StatusDot status={backup.lastStatus} />
            {backup.lastRunAt ? timeAgo(backup.lastRunAt) : ""}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={backup.enabled}
          onCheckedChange={toggle}
          disabled={pending}
        />
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Backup menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {menu(DROPDOWN_KIT)}
          </DropdownMenuContent>
        </DropdownMenu>
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Delete ${backup.name}?`}
          description="This removes the backup schedule. Existing backup files in your bucket are not deleted."
          confirmLabel="Delete schedule"
          successMessage="Backup schedule deleted"
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation($id: String!) { deleteBackup(id: $id) }`,
              { id: backup.id }
            );
            if (res.ok) router.refresh();
            return res;
          }}
        />
        {/* Restore from a recent run of this schedule's target. */}
        {targetId && (
          <RestoreRunsDialog
            open={restoreOpen}
            onOpenChange={setRestoreOpen}
            targetKind={backup.targetKind}
            targetId={targetId}
            targetName={targetName ?? backup.name}
          />
        )}
      </TableCell>
    </TableRow>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {menu(CONTEXT_KIT)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
