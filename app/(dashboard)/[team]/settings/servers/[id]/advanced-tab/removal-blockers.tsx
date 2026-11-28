"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ArrowRightLeft,
  ChevronDown,
  Loader2,
  Network,
  Server,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { AppLogo, LogoImage } from "@/components/shared/project-logo";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { DB_LOGOS } from "@/components/storage/db-engines";
import type { DatabaseType } from "@/lib/types/database";
import { gqlAction } from "@/lib/graphql-client";
import { plural } from "@/lib/utils";

type Target = { id: string; name: string };
type Item = {
  id: string;
  name: string;
  teamName: string;
  teamAvatarUrl: string | null;
  logo: string | null;
  logoTone: "dark" | "light" | null;
  engine: string | null;
  moveTo: Target[];
  note: string;
};
type Destination = {
  id: string;
  name: string;
  teamName: string;
  teamAvatarUrl: string | null;
  schedules: number;
  artifacts: number;
};
export type RemovalBlockers = {
  apps: Item[];
  databases: Item[];
  clusters: Item[];
  destinations: Destination[];
  copying: string[];
  online: boolean;
};

const BLOCKERS = /* GraphQL */ `
  query ServerRemovalBlockers($id: String!) {
    serverRemovalBlockers(id: $id) {
      apps {
        ...RemovalItem
      }
      databases {
        ...RemovalItem
      }
      clusters {
        ...RemovalItem
      }
      destinations {
        id
        name
        teamName
        teamAvatarUrl
        schedules
        artifacts
      }
      copying
      online
    }
  }
  fragment RemovalItem on ServerRemovalItem {
    id
    name
    teamName
    teamAvatarUrl
    logo
    logoTone
    engine
    note
    moveTo {
      id
      name
    }
  }
`;

const MOVE_OFF = /* GraphQL */ `
  mutation MoveOffServer(
    $serverId: String!
    $kind: String!
    $id: String!
    $toServerId: String!
  ) {
    moveOffServer(
      serverId: $serverId
      kind: $kind
      id: $id
      toServerId: $toServerId
    )
  }
`;

const MOVE_LEADER = /* GraphQL */ `
  mutation MoveClusterLeader($id: String!, $serverId: String!) {
    moveClusterLeader(id: $id, serverId: $serverId) {
      id
    }
  }
`;

const REMOVE_DESTINATION = /* GraphQL */ `
  mutation RemoveDestinationOffServer(
    $serverId: String!
    $id: String!
    $deleteArtifacts: Boolean
  ) {
    removeDestinationOffServer(
      serverId: $serverId
      id: $id
      deleteArtifacts: $deleteArtifacts
    )
  }
`;

const POLL_MS = 5000;

export const isClear = (b: RemovalBlockers) =>
  b.apps.length +
    b.databases.length +
    b.clusters.length +
    b.destinations.length ===
  0;

/** What keeps the server from going, read while the dialog is open: a move finishes on its own. */
export function useRemovalBlockers(serverId: string) {
  const [blockers, setBlockers] = React.useState<RemovalBlockers | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const refresh = React.useCallback(async () => {
    const res = await gqlAction<{ serverRemovalBlockers: RemovalBlockers }>(
      BLOCKERS,
      { id: serverId },
    );
    if (res.ok && res.data) {
      setBlockers(res.data.serverRemovalBlockers);
      setError(null);
    } else if (!res.ok) setError(res.error);
  }, [serverId]);
  React.useEffect(() => {
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);
  return { blockers, error, refresh };
}

export function RemovalBlockerList({
  serverId,
  blockers,
  refresh,
}: {
  serverId: string;
  blockers: RemovalBlockers;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<Destination | null>(null);

  async function run(
    key: string,
    action: () => ReturnType<typeof gqlAction>,
    done: string,
  ) {
    setBusy(key);
    const res = await action();
    if (res.ok) toast.success(done);
    else toast.error(res.error);
    await refresh();
    setBusy(null);
  }

  const workload = (kind: "app" | "database") => (item: Item, to: Target) =>
    run(
      item.id,
      () =>
        gqlAction(MOVE_OFF, {
          serverId,
          kind,
          id: item.id,
          toServerId: to.id,
        }),
      `Moving ${item.name} to ${to.name}`,
    );

  return (
    <div className="space-y-4">
      <Section title="Apps" items={blockers.apps} icon={workloadIcon}>
        {(item) => (
          <MoveMenu
            item={item}
            busy={busy}
            onMove={workload("app")}
            none="No other server its team can use"
          />
        )}
      </Section>
      <Section title="Databases" items={blockers.databases} icon={workloadIcon}>
        {(item) => (
          <MoveMenu
            item={item}
            busy={busy}
            onMove={workload("database")}
            none="No other server its team can use"
          />
        )}
      </Section>
      <Section
        title="Cluster leaders"
        items={blockers.clusters}
        icon={() => <GlyphIcon icon={Network} />}
      >
        {(item) => (
          <MoveMenu
            item={item}
            busy={busy}
            none="No other server is online"
            onMove={(c, to) =>
              run(
                c.id,
                () => gqlAction(MOVE_LEADER, { id: c.id, serverId: to.id }),
                `The leader of ${c.name} now runs on ${to.name}`,
              )
            }
          />
        )}
      </Section>
      <Section
        title="Backup destinations"
        items={blockers.destinations}
        icon={() => <GlyphIcon icon={Server} />}
      >
        {(d) => (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => setRemoving(d)}
          >
            <Trash2 className="size-4" />
            Remove
          </Button>
        )}
      </Section>
      {removing && (
        <RemoveDestinationConfirm
          serverId={serverId}
          destination={removing}
          online={blockers.online}
          onClose={() => setRemoving(null)}
          onRemoved={refresh}
        />
      )}
    </div>
  );
}

const ICON = 32;

function workloadIcon(item: Item) {
  const engine = item.engine as DatabaseType | null;
  return (
    <AppLogo
      logo={item.logo ?? (engine ? (DB_LOGOS[engine] ?? null) : null)}
      tone={item.logoTone}
      size={ICON}
    />
  );
}

function GlyphIcon({ icon: Icon }: { icon: typeof Server }) {
  return (
    <LogoImage
      src={null}
      size={ICON}
      fallback={<Icon style={{ width: ICON / 2, height: ICON / 2 }} />}
    />
  );
}

function Section<
  T extends {
    id: string;
    name: string;
    teamName: string;
    teamAvatarUrl: string | null;
  },
>({
  title,
  items,
  icon,
  children,
}: {
  title: string;
  items: T[];
  icon: (item: T) => React.ReactNode;
  children: (item: T) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{title}</div>
      <ul className="divide-y rounded-lg border bg-card">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-3 px-3 py-2.5"
          >
            <div className="flex min-w-0 items-center gap-3">
              {icon(item)}
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{item.name}</div>
                {item.teamName && (
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <TeamAvatar
                      name={item.teamName}
                      avatarUrl={item.teamAvatarUrl}
                      size="xs"
                    />
                    <span className="truncate">{item.teamName}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="shrink-0">{children(item)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MoveMenu({
  item,
  busy,
  none,
  onMove,
}: {
  item: Item;
  busy: string | null;
  none: string;
  onMove: (item: Item, to: Target) => void;
}) {
  if (item.note || item.moveTo.length === 0)
    return (
      <span className="text-xs text-muted-foreground">{item.note || none}</span>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy !== null}>
          {busy === item.id ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowRightLeft className="size-4" />
          )}
          {busy === item.id ? "Moving" : "Move to"}
          <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {item.moveTo.map((to) => (
          <DropdownMenuItem key={to.id} onSelect={() => onMove(item, to)}>
            {to.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RemoveDestinationConfirm({
  serverId,
  destination: d,
  online,
  onClose,
  onRemoved,
}: {
  serverId: string;
  destination: Destination;
  online: boolean;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const [alsoFiles, setAlsoFiles] = React.useState(true);
  // An offline server cannot delete anything, so its files can only stay.
  const canDelete = online && d.artifacts > 0;
  const deleting = canDelete && alsoFiles;
  return (
    <ConfirmAction
      open
      onOpenChange={(open) => !open && onClose()}
      title="Remove destination?"
      description={
        <>
          Removing <strong>{d.name}</strong> of {d.teamName} deletes{" "}
          {plural(d.schedules, "backup schedule", "backup schedules")} too.
        </>
      }
      consequence={
        d.artifacts === 0
          ? undefined
          : deleting
            ? "The backup files are deleted too, and nothing can be restored from them afterwards."
            : online
              ? "The backup files stay on the server, and nothing in Deplo can open them again."
              : "The server is offline, so its backup files stay there and nothing in Deplo can open them again."
      }
      extra={
        canDelete ? (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border p-3 text-sm">
            <Checkbox
              checked={alsoFiles}
              onCheckedChange={(v) => setAlsoFiles(v === true)}
              className="mt-0.5"
            />
            <span className="font-medium">
              Also delete the{" "}
              {plural(d.artifacts, "backup file", "backup files")}
            </span>
          </label>
        ) : undefined
      }
      confirmText={d.name}
      confirmLabel="Remove destination"
      successMessage="Destination removed"
      onConfirm={async () => {
        const res = await gqlAction(REMOVE_DESTINATION, {
          serverId,
          id: d.id,
          deleteArtifacts: deleting,
        });
        await onRemoved();
        return res;
      }}
    />
  );
}
