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
import { DeleteDatabaseDialog } from "@/components/storage/delete-database-dialog";
import { DatabaseConnectionString } from "@/components/storage/database-connection-string";
import { DatabaseLiveStatusProvider } from "@/components/storage/database-live-status";
import {
  DatabaseStatusBadge,
  DatabaseStatusDot,
} from "@/components/storage/database-status-badge";
import { cn } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import { DatabaseLogo } from "./database-logo";
import { DB_NAMES } from "./db-engines";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * A database on the Storage grid - visually aligned with the Overview app card: a
 * whole-card stretched link into the detail page, an engine-icon tile, a live
 * status, and a ⋯ actions menu.
 */
export function DatabaseCard({
  db,
  serverName,
  view = "grid",
  dragHandle,
  dragActive = false,
  pollMs = 15000,
  canReveal = true,
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
  /** The viewer holds `manage_infra` - the capability `revealConnection` needs. */
  canReveal?: boolean;
}) {
  // Still arriving: a migration is creating this database and copying its volume
  // across, and every mutation on it is refused server-side until that run ends.
  if (db.migrationRunId)
    return (
      <div
        aria-busy
        title="This is still being brought over by a migration"
        className="pointer-events-none animate-pulse opacity-70 select-none"
      >
        <DatabaseLiveStatusProvider
          initial={{ id: db.id, name: db.name, status: db.status }}
        >
          {view === "list" ? (
            <DatabaseCardList
              db={db}
              serverName={serverName}
              dragActive
              pollMs={pollMs}
              canReveal={canReveal}
            />
          ) : (
            <DatabaseCardGrid
              db={db}
              serverName={serverName}
              dragActive
              pollMs={pollMs}
              canReveal={canReveal}
            />
          )}
        </DatabaseLiveStatusProvider>
      </div>
    );

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
          canReveal={canReveal}
        />
      ) : (
        <DatabaseCardGrid
          db={db}
          serverName={serverName}
          dragHandle={dragHandle}
          dragActive={dragActive}
          pollMs={pollMs}
          canReveal={canReveal}
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
  canReveal: boolean;
}

function DatabaseCardGrid({
  db,
  serverName,
  dragHandle,
  dragActive,
  pollMs,
  canReveal,
}: Inner) {
  const href = `/storage/databases/${db.id}`;
  return (
    <Card className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20">
      {/* Stretched link: the whole card is clickable. Interactive controls
          below opt back into pointer events and sit above this overlay. */}
      <OverlayLink href={href} label={db.name} dragActive={dragActive} />

      <div className="pointer-events-none relative z-[1] flex flex-1 flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <DatabaseLogo type={db.type} logo={db.logo} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{db.name}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {DB_NAMES[db.type] ?? db.type} · v{db.version}
              </p>
            </div>
          </div>
          <CardActions db={db} dragHandle={dragHandle} pollMs={pollMs} />
        </div>

        {/**
         * Connection box - the databases analogue of the app card's latest-deployment box:
         * the connection string up top as the same click-to-reveal chip the Variables page
         * uses (masked, so the endpoint still reads at a glance), placement + exposure
         */}
        <div className="rounded-lg border border-border bg-secondary/40 p-3">
          <ConnectionChip db={db} canReveal={canReveal} />
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ServerIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{serverName ?? "—"}</span>
            <span className="shrink-0 text-muted-foreground/40">·</span>
            {db.exposedPublicly ? (
              <Globe className="size-3.5 shrink-0" />
            ) : (
              <Lock className="size-3.5 shrink-0" />
            )}
            <span className="shrink-0">
              {db.exposedPublicly && db.exposedPort
                ? `Public · ${db.exposedPort}`
                : "Internal"}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function DatabaseCardList({
  db,
  serverName,
  dragHandle,
  dragActive,
  pollMs,
}: Inner) {
  const href = `/storage/databases/${db.id}`;
  return (
    <Card className="group relative flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
      <OverlayLink href={href} label={db.name} dragActive={dragActive} />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-4">
        <DatabaseLogo type={db.type} logo={db.logo} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{db.name}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {DB_NAMES[db.type] ?? db.type} · v{db.version} ·{" "}
            <span className="font-mono">
              {db.host}:{db.port}
            </span>
          </p>
        </div>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
          {db.exposedPublicly ? (
            <Globe className="size-3.5 shrink-0" />
          ) : (
            <Lock className="size-3.5 shrink-0" />
          )}
          {db.exposedPublicly && db.exposedPort
            ? `Public · ${db.exposedPort}`
            : "Internal"}
        </span>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <ServerIcon className="size-3.5 shrink-0" />
          <span className="max-w-32 truncate">{serverName ?? "—"}</span>
        </span>
      </div>
      <CardActions db={db} dragHandle={dragHandle} pollMs={pollMs} listView />
    </Card>
  );
}

/** The whole-card click target (stretched over everything at z-0). The content
 *  layer above it is `pointer-events-none`, so every pixel of the card shows the
 *  pointer cursor and clicks fall through to this link; controls opt back in. */
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
      // Inert during a reorder drag so a drop never navigates, and not
      // focusable so keyboard users can't fall through to it mid-reorder.
      tabIndex={dragActive ? -1 : undefined}
      aria-hidden={dragActive || undefined}
      className={cn(
        "absolute inset-0 z-0 rounded-xl",
        dragActive ? "pointer-events-none cursor-default" : "cursor-pointer",
      )}
    />
  );
}

/**
 * The connection string, revealable and copyable without leaving the grid.
 */
function ConnectionChip({
  db,
  canReveal,
}: {
  db: DatabaseDTO;
  canReveal: boolean;
}) {
  return (
    <div
      data-card-actions
      className="pointer-events-auto relative z-10"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <DatabaseConnectionString
        id={db.id}
        masked={db.connectionStringMasked}
        canReveal={canReveal}
      />
    </div>
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

  // `data-card-actions` + the pointer-events/z lift keep this cluster clickable
  // above the overlay link (the same contract AppCard uses).
  return (
    <div
      data-card-actions
      className="pointer-events-auto relative z-10 flex items-center gap-1"
    >
      {listView ? (
        <DatabaseStatusBadge id={db.id} status={db.status} pollMs={pollMs} />
      ) : (
        <DatabaseStatusDot id={db.id} status={db.status} pollMs={pollMs} />
      )}
      {/* Drag handle is out of the flow at rest (display:none) so it leaves no
          empty gap; it slides + fades in on hover / keyboard focus. */}
      {dragHandle && (
        <span className="hidden animate-in items-center duration-200 fade-in-0 slide-in-from-right-2 group-hover:flex focus-within:flex">
          {dragHandle}
        </span>
      )}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
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
              {running ? (
                <Square className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
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
      </div>

      <DeleteDatabaseDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        databaseId={db.id}
        databaseName={db.name}
        onDeleted={() => router.refresh()}
      />
    </div>
  );
}
