"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  Eye,
  EyeOff,
  Play,
  Square,
  Pencil,
  Trash2,
  Server as ServerIcon,
  Database as DatabaseIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { StatusBadge } from "@/components/shared/status-badge";
import { CopyButton } from "@/components/shared/copy-button";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { formatBytes, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import { DB_ICONS, ENGINE_CREDS } from "./db-engines";
import type { DatabaseDTO } from "@/lib/data/databases";

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

export function DatabaseCard({
  db,
  canExposePorts = false,
}: {
  db: DatabaseDTO;
  /**
   * Whether the current user holds the publish-ports grant. Gates the "Expose
   * publicly" control in the edit dialog (the server re-checks it on update too).
   */
  canExposePorts?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const running = db.status === "running";
  const Icon = DB_ICONS[db.type] ?? DatabaseIcon;

  function toggleRunning() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $running: Boolean!) { setDatabaseRunning(id: $id, running: $running) { id } }`,
        { id: db.id, running: !running },
      );
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(running ? "Database stopped" : "Database started");
        router.refresh();
      }
    });
  }

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
      else if (!res.ok) toast.error(res.error);
    });
  }

  // The card's actions, rendered once for whichever menu primitive is passed —
  // the ⋯ dropdown (left-click) and the right-click context menu share them.
  const menu = (K: MenuKit) => (
    <>
      <K.Item onSelect={toggleRunning} disabled={pending}>
        {running ? <Square className="size-4" /> : <Play className="size-4" />}
        {running ? "Stop" : "Start"}
      </K.Item>
      <K.Item
        onSelect={(e: Event) => {
          e.preventDefault();
          setEditOpen(true);
        }}
      >
        <Pencil className="size-4" />
        Edit…
      </K.Item>
      <K.Separator />
      <K.Item
        variant="destructive"
        onSelect={(e: Event) => {
          e.preventDefault();
          setConfirmOpen(true);
        }}
      >
        <Trash2 className="size-4" />
        Delete
      </K.Item>
    </>
  );

  const cardInner = (
    <Card onContextMenu={(e) => e.stopPropagation()}>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-secondary text-foreground">
              <Icon className="size-5" />
            </div>
            <div>
              <p className="font-medium">{db.name}</p>
              <p className="text-xs capitalize text-muted-foreground">
                {db.type} · v{db.version}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={db.status} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Database menu">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {menu(DROPDOWN_KIT)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Connection string</span>
            <button
              onClick={reveal}
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

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ServerIcon className="size-3.5" />
            {db.host}:{db.port}
          </span>
          <span>{formatBytes(db.sizeMb * 1024 * 1024)}</span>
          <span className="ml-auto">{timeAgo(db.createdAt)}</span>
        </div>
      </CardContent>

      <DeleteWithArtifacts
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        targetKind="database"
        targetId={db.id}
        targetName={db.name}
        title={`Delete ${db.name}?`}
        description="This permanently destroys the database container and all its data, including any backup schedules attached to it."
        confirmLabel="Delete database"
        successMessage="Database deleted"
        deleteMutation={() =>
          gqlAction(`mutation($id: String!) { deleteDatabase(id: $id) }`, {
            id: db.id,
          })
        }
        onDeleted={() => router.refresh()}
      />

      {/* Remounted on each open (via key) so the form always seeds fresh from
          `db` and a cancelled edit never leaks stale input into the next open —
          same trick as EditBackupDialog. */}
      <EditDatabaseDialog
        key={editOpen ? "edit-open" : "edit-closed"}
        db={db}
        canExposePorts={canExposePorts}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </Card>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{cardInner}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">{menu(CONTEXT_KIT)}</ContextMenuContent>
    </ContextMenu>
  );
}

/* ------------------------------------------------------------------ */
/* Edit dialog                                                         */
/* ------------------------------------------------------------------ */

/**
 * Edit an existing database. Engine, version, username and database name are
 * fixed at creation (the official images apply those env vars only on first init
 * against an empty volume), so they are shown READ-ONLY. The only editable
 * setting is public exposure + the host port — the server re-renders the compose
 * and reroutes the container in place (the data volume is preserved). Mirrors
 * EditBackupDialog: seeded from `db` on mount, remounted via `key` on each open.
 */
function EditDatabaseDialog({
  db,
  canExposePorts,
  open,
  onOpenChange,
}: {
  db: DatabaseDTO;
  canExposePorts: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [exposed, setExposed] = React.useState(db.exposedPublicly);
  const [port, setPort] = React.useState(
    db.exposedPort ? String(db.exposedPort) : "",
  );
  const [generatingPort, setGeneratingPort] = React.useState(false);
  const creds = ENGINE_CREDS[db.type];

  const parsedPort = Number.parseInt(port, 10);
  const portValid =
    Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535;
  const exposeReady = !exposed || portValid;
  // Only submit when the exposure config actually changed — avoids a pointless
  // reroute (a container recreate) when nothing was touched.
  const dirty =
    exposed !== db.exposedPublicly ||
    (exposed && parsedPort !== db.exposedPort);

  // Ask the server for a free host port on THIS database's server (the generate
  // RPC only needs the server id, which the card already has).
  function generatePort() {
    setGeneratingPort(true);
    startTransition(async () => {
      const res = await gqlAction<{ generateAvailableDbPort: number }, number>(
        `mutation($serverId: ID) { generateAvailableDbPort(serverId: $serverId) }`,
        { serverId: db.serverId },
        (d) => d.generateAvailableDbPort,
      );
      setGeneratingPort(false);
      if (res.ok) setPort(String(res.data));
      else toast.error(res.error);
    });
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateDatabaseInput!) {
          updateDatabase(id: $id, input: $input) { id }
        }`,
        {
          id: db.id,
          input: {
            exposedPublicly: exposed,
            exposedPort: exposed ? parsedPort : null,
          },
        },
      );
      if (res.ok) {
        toast.success("Database updated");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onContextMenu={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Edit {db.name}</DialogTitle>
          <DialogDescription>
            Only public exposure can be changed. Engine, version, and credentials
            are fixed at creation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* Read-only summary of the create-only settings. */}
          <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Engine</span>
              <span className="capitalize">
                {db.type} · v{db.version}
              </span>
            </div>
            {creds.username && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Username</span>
                <code className="truncate font-mono text-xs">
                  {db.username}
                </code>
              </div>
            )}
            {creds.dbName && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Database</span>
                <code className="truncate font-mono text-xs">{db.dbName}</code>
              </div>
            )}
            <p className="pt-1 text-xs text-muted-foreground">
              Changing these requires recreating the database.
            </p>
          </div>

          {/* The only editable setting. */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Expose publicly</p>
                <p className="text-xs text-muted-foreground">
                  Publish the port to the internet. Keep off unless required.
                </p>
              </div>
              {canExposePorts ? (
                <Switch checked={exposed} onCheckedChange={setExposed} />
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>
                      <Switch checked={exposed} disabled />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    You don&apos;t have permission to publish ports
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {exposed && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-db-port">Host port</Label>
                <div className="flex gap-2">
                  <Input
                    id="edit-db-port"
                    inputMode="numeric"
                    value={port}
                    onChange={(e) =>
                      setPort(e.target.value.replace(/[^0-9]/g, ""))
                    }
                    placeholder="e.g. 25432"
                    aria-invalid={port !== "" && !portValid}
                    disabled={!canExposePorts}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={generatePort}
                    disabled={generatingPort || pending || !canExposePorts}
                  >
                    {generatingPort ? "Finding…" : "Generate"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The port on the server clients connect to. Use an unprivileged
                  port (1024–65535) that is free on the host, or click Generate.
                </p>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !exposeReady || !dirty}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
