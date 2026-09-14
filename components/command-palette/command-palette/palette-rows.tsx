"use client";

import * as React from "react";
import { Box } from "lucide-react";

import { CommandItem } from "@/components/ui/command";
import { AppLogo } from "@/components/shared/project-logo";
import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { DatabaseLogo } from "@/components/storage/database-logo";
import type { Entry, EntryOwner } from "@/lib/command-palette/entries";
import type { Hit } from "./search-hits";

// groupBy - rows in the order they arrived, gathered under their group heading.
export function groupBy<T extends { group: string }>(
  rows: T[],
): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.group);
    if (list) list.push(row);
    else out.set(row.group, [row]);
  }
  return [...out];
}

// EntryRow - one in-bundle entry: a page, a setting, a command.
export function EntryRow({
  entry,
  onChoose,
}: {
  entry: Entry;
  onChoose: (entry: Entry) => void | Promise<void>;
}) {
  const { owner, team } = entry;
  return (
    <CommandItem value={entry.id} onSelect={() => void onChoose(entry)}>
      {owner ? (
        <OwnedIcon owner={owner} icon={entry.icon} />
      ) : team ? (
        <BadgedMark icon={entry.icon}>
          <TeamAvatar name={team.name} avatarUrl={team.avatarUrl} size="sm" />
        </BadgedMark>
      ) : (
        <entry.icon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">
        {owner && (
          <span className="text-muted-foreground">
            {owner.name} /{entry.group === "Settings" ? " Settings /" : ""}{" "}
          </span>
        )}
        {entry.label}
      </span>
      {entry.hint && !owner && (
        <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
          {entry.hint}
        </span>
      )}
    </CommandItem>
  );
}

function OwnedIcon({
  owner,
  icon,
}: {
  owner: EntryOwner;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <BadgedMark icon={icon}>
      {owner.kind === "app" ? (
        <AppLogo logo={owner.logo} size={20} />
      ) : (
        <DatabaseLogo type={owner.type} logo={owner.logo} size={20} />
      )}
    </BadgedMark>
  );
}

function BadgedMark({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      {children}
      <span className="absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full border border-border bg-background">
        <Icon className="size-2 text-muted-foreground" />
      </span>
    </span>
  );
}

// HitRow - one search hit: an app, a database, a member, a domain.
export function HitRow({
  hit,
  onChoose,
  showTeam = false,
}: {
  hit: Hit;
  onChoose: (hit: Hit) => void;
  showTeam?: boolean;
}) {
  const Icon = hit.icon ?? Box;
  return (
    <CommandItem value={hit.id} onSelect={() => onChoose(hit)}>
      {hit.logo?.kind === "app" ? (
        <AppLogo logo={hit.logo.logo} size={20} />
      ) : hit.logo?.kind === "database" ? (
        <DatabaseLogo type={hit.logo.type} logo={hit.logo.logo} size={20} />
      ) : hit.logo?.kind === "person" ? (
        <UserAvatar
          name={hit.logo.name}
          avatarUrl={hit.logo.avatarUrl}
          size="sm"
        />
      ) : hit.logo?.kind === "team" ? (
        <TeamAvatar
          name={hit.logo.name}
          avatarUrl={hit.logo.avatarUrl}
          size="sm"
        />
      ) : (
        <Icon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{hit.label}</span>
      {showTeam && hit.team ? (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <TeamAvatar
            name={hit.team.name}
            avatarUrl={hit.team.avatarUrl}
            size="xs"
          />
          <span className="max-w-32 truncate">{hit.team.name}</span>
        </span>
      ) : (
        hit.hint && (
          <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
            {hit.hint}
          </span>
        )
      )}
    </CommandItem>
  );
}
