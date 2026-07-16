"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  Play,
  Square,
  ArrowUpRight,
  Trash2,
  Server as ServerIcon,
  Globe,
  Lock,
  Database as DatabaseIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { DatabaseLiveStatusProvider } from "@/components/storage/database-live-status";
import {
  DatabaseStatusBadge,
  DatabaseStatusDot,
} from "@/components/storage/database-status-badge";
import { timeAgo, cn } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import { DB_ICONS } from "./db-engines";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * A database on the Storage grid — visually aligned with the Overview app card:
 * a whole-card stretched link into the detail page, an engine-icon tile, a live
 * status, and a ⋯ actions menu. Grid (default) and list layouts, plus an
 * optional injected drag handle for reorder (mirrors AppCard's contract).
 *
 * Wrapped in its own live-status provider so a card outside the detail layout
 * still flips provisioning → running and surfaces crash states without a reload.
 */
export function DatabaseCard({
  db,
  serverName,
  view = "grid",
  dragHandle,
  dragActive = false,
  pollMs = 15000,
}: {
  db: DatabaseDTO;
  serverName?: string;
  view?: "grid" | "list";
  /** Injected reorder handle (shown on hover); omit for a non-draggable card. */
  dragHandle?: React.ReactNode;
  /** A reorder drag is in flight → make the overlay link inert so a drop can't navigate. */
  dragActive?: boolean;
  /** Runtime-poll cadence for the status badge (slower on the list to stay light). */
  pollMs?: number;
}) {
  return (
    <DatabaseLiveStatusProvider
      initial={{ id: db.id, name: db.name, status: db.status }}
    >
      {view === "list" ? (
        <DatabaseCardList
          db={db}
          serverName={serverName}
          dragHandle={dragHandle}
          dragActive={dragActive}
          pollMs={pollMs}
        />
      ) : (
        <DatabaseCardGrid
          db={db}
          serverName={serverName}
          dragHandle={dragHandle}
          dragActive={dragActive}
          pollMs={pollMs}
        />
      )}
    </DatabaseLiveStatusProvider>
  );
}

interface Inner {
  db: DatabaseDTO;
  serverName?: string;
  dragHandle?: React.ReactNode;
  dragActive: boolean;
  pollMs: number;
}

function DatabaseCardGrid({ db, serverName, dragHandle, dragActive, pollMs }: Inner) {
  const href = `/storage/databases/${db.id}`;
  const Icon = DB_ICONS[db.type] ?? DatabaseIcon;
  return (
    <Card className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20">
      <OverlayLink href={href} label={db.name} dragActive={dragActive} />
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-foreground">
            <Icon className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">{db.name}</p>
            <p className="truncate text-xs capitalize text-muted-foreground">
              {db.type} · v{db.version}
            </p>
          </div>
        </div>
        <CardActions db={db} dragHandle={dragHandle} pollMs={pollMs} />
      </div>

      <div className="relative z-0 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <Meta icon={ServerIcon} label={serverName ?? "—"} />
        <Meta
          icon={db.exposedPublicly ? Globe : Lock}
          label={
            db.exposedPublicly && db.exposedPort
              ? `Public · ${db.exposedPort}`
              : "Internal"
          }
        />
        <span className="col-span-2 truncate font-mono text-muted-foreground">
          {db.host}:{db.port}
        </span>
      </div>

      <div className="relative z-0 mt-auto text-xs text-muted-foreground">
        Created {timeAgo(db.createdAt)}
      </div>
    </Card>
  );
}

function DatabaseCardList({ db, serverName, dragHandle, dragActive, pollMs }: Inner) {
  const href = `/storage/databases/${db.id}`;
  const Icon = DB_ICONS[db.type] ?? DatabaseIcon;
  return (
    <Card className="group relative flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
      <OverlayLink href={href} label={db.name} dragActive={dragActive} />
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-foreground">
        <Icon className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{db.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          <span className="capitalize">{db.type}</span> · v{db.version} ·{" "}
          <span className="font-mono">
            {db.host}:{db.port}
          </span>
        </p>
      </div>
      <span className="relative z-0 hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
        <ServerIcon className="size-3.5" />
        {serverName ?? "—"}
      </span>
      <CardActions db={db} dragHandle={dragHandle} pollMs={pollMs} listView />
    </Card>
  );
}

/** The whole-card click target (stretched over everything at z-0). Actions and
 *  metadata sit at `relative z-0` so they read above it; the ⋯ menu is z-raised. */
function OverlayLink({
  href,
  label,
  dragActive,
}: {
  href: string;
  label: string;
  dragActive: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label={`Open ${label}`}
      // Inert during a reorder drag so a drop never navigates.
      className={cn(
        "absolute inset-0 z-0 rounded-xl",
        dragActive && "pointer-events-none",
      )}
    />
  );
}

function Meta({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5 truncate text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function CardActions({
  db,
  dragHandle,
  pollMs,
  listView = false,
}: {
  db: DatabaseDTO;
  dragHandle?: React.ReactNode;
  pollMs: number;
  listView?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const running = db.status === "running";
  const href = `/storage/databases/${db.id}`;

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

  // `data-card-actions` + relative z lift this cluster above the overlay link so
  // its buttons stay clickable (the same contract AppCard uses).
  return (
    <div
      data-card-actions
      className="relative z-10 flex items-center gap-1.5"
    >
      {listView ? (
        <DatabaseStatusBadge id={db.id} status={db.status} pollMs={pollMs} />
      ) : (
        <DatabaseStatusDot id={db.id} status={db.status} pollMs={pollMs} />
      )}
      {dragHandle}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Database menu">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem asChild>
            <Link href={href}>
              <ArrowUpRight className="size-4" />
              Open
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={toggleRunning} disabled={pending}>
            {running ? <Square className="size-4" /> : <Play className="size-4" />}
            {running ? "Stop" : "Start"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirmOpen(true)}
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
    </div>
  );
}
