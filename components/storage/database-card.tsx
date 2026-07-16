"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  Eye,
  EyeOff,
  Play,
  Square,
  ArrowUpRight,
  Trash2,
  Server as ServerIcon,
  Database as DatabaseIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CopyButton } from "@/components/shared/copy-button";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import {
  DatabaseLiveStatusProvider,
} from "@/components/storage/database-live-status";
import { DatabaseStatusBadge } from "@/components/storage/database-status-badge";
import { formatBytes, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import { DB_ICONS } from "./db-engines";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * A database on the /storage list. The whole card links into the database's
 * detail page (`/storage/databases/<id>`) — where the real management lives now
 * (the edit modal is gone). The card keeps a quick-actions menu (Open / Start /
 * Stop / Delete) and a live status badge. A slower runtime poll (15s) keeps
 * per-card polling light; the 3s server cache absorbs a burst of cards.
 */
export function DatabaseCard({ db }: { db: DatabaseDTO }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const running = db.status === "running";
  const Icon = DB_ICONS[db.type] ?? DatabaseIcon;
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

  // Wrap the badge in its own provider so a card outside the detail layout still
  // gets live subscription updates (provisioning → running, crash states).
  return (
    <DatabaseLiveStatusProvider
      initial={{ id: db.id, name: db.name, status: db.status }}
    >
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start justify-between">
            <Link href={href} className="flex items-center gap-3 group">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-secondary text-foreground">
                <Icon className="size-5" />
              </div>
              <div>
                <p className="font-medium group-hover:underline">{db.name}</p>
                <p className="text-xs capitalize text-muted-foreground">
                  {db.type} · v{db.version}
                </p>
              </div>
            </Link>
            <div className="flex items-center gap-2">
              <DatabaseStatusBadge id={db.id} status={db.status} pollMs={15000} />
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
            <span>{db.sizeMb > 0 ? formatBytes(db.sizeMb * 1024 * 1024) : "—"}</span>
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
      </Card>
    </DatabaseLiveStatusProvider>
  );
}
