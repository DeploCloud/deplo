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
  Trash2,
  Server as ServerIcon,
  Database as DatabaseIcon,
  Leaf,
  MemoryStick,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/shared/status-badge";
import { CopyButton } from "@/components/shared/copy-button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { formatBytes, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases";

const DB_ICONS: Record<string, LucideIcon> = {
  postgres: DatabaseIcon,
  mysql: DatabaseIcon,
  mariadb: DatabaseIcon,
  mongodb: Leaf,
  redis: MemoryStick,
  clickhouse: BarChart3,
};

export function DatabaseCard({ db }: { db: DatabaseDTO }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
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

  return (
    <Card>
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
                <DropdownMenuItem onClick={toggleRunning} disabled={pending}>
                  {running ? <Square className="size-4" /> : <Play className="size-4" />}
                  {running ? "Stop" : "Start"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={(e) => {
                    e.preventDefault();
                    setConfirmOpen(true);
                  }}
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
            <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
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

      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${db.name}?`}
        description="This permanently destroys the database container and all its data, including any backups schedules attached to it."
        confirmLabel="Delete database"
        successMessage="Database deleted"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: String!) { deleteDatabase(id: $id) }`,
            { id: db.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </Card>
  );
}
