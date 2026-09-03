"use client";

import * as React from "react";
import { Check, Globe, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { FieldLabel } from "@/components/ui/info-tip";
import { veilProps } from "@/components/templates/veil";
import { cn } from "@/lib/utils";

export interface TeamOption {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

export interface ServerAccess {
  allTeams: boolean;
  teamIds: string[];
}

/** "Specific teams" with nothing ticked would lock every team out. */
export function accessIsComplete(a: ServerAccess) {
  return a.allTeams || a.teamIds.length > 0;
}

/**
 * Controlled editor for a server's "all teams / specific teams" choice. Pure UI:
 * the parent owns the value and persists it (addServer / setServerTeams).
 */
export function ServerTeamAccess({
  value,
  teams,
  onChange,
  disabled,
}: {
  value: ServerAccess;
  teams: TeamOption[];
  onChange: (next: ServerAccess) => void;
  disabled?: boolean;
}) {
  const selected = new Set(value.teamIds);

  function toggleTeam(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange({ allTeams: false, teamIds: [...next] });
  }

  return (
    <div className="space-y-2">
      <FieldLabel
        info="Which teams are allowed to deploy to this server."
        docs="servers.teams"
      >
        Team access
      </FieldLabel>
      <div className="grid grid-cols-2 gap-2">
        <AccessOption
          icon={Globe}
          title="All teams"
          description="Every team can deploy here"
          selected={value.allTeams}
          disabled={disabled}
          onSelect={() => onChange({ allTeams: true, teamIds: [] })}
        />
        <AccessOption
          icon={Users}
          title="Specific teams"
          description="Only the teams you pick"
          selected={!value.allTeams}
          disabled={disabled}
          onSelect={() => onChange({ allTeams: false, teamIds: value.teamIds })}
        />
      </div>

      {!value.allTeams && (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
          {teams.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              No teams to choose from.
            </p>
          ) : (
            teams.map((team) => (
              <label
                key={team.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
              >
                <Checkbox
                  checked={selected.has(team.id)}
                  onCheckedChange={(c) => toggleTeam(team.id, c === true)}
                  disabled={disabled}
                />
                <TeamAvatar name={team.name} avatarUrl={team.avatarUrl} />
                <span className="truncate text-sm">{team.name}</span>
              </label>
            ))
          )}
        </div>
      )}
      {!value.allTeams && selected.size > 0 && (
        <p className="text-xs text-muted-foreground">
          {`${selected.size} team${selected.size === 1 ? "" : "s"} selected.`}
        </p>
      )}
    </div>
  );
}

/**
 * One card in a card-shaped radio group.
 */
export function AccessOption({
  icon: Icon,
  title,
  description,
  selected,
  disabled,
  onSelect,
  badge,
  accent,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** A short chip beside the title, e.g. "Beta". */
  badge?: React.ReactNode;
  /**
   * Give the option a colour of its own: the icon wears the token, the card
   * wears the same hue as a wash. Omitted, the option stays neutral - which is
   * right where the choice is one thing or its opposite.
   */
  accent?: { hue: number; iconClassName: string };
}) {
  // The wash the template store, the MCP wizard and the deploy sources share.
  const veil = accent
    ? veilProps({ hue: accent.hue }, selected ? "on" : "hover")
    : {};
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      style={veil.style}
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
        selected
          ? accent
            ? "border-primary ring-1 ring-primary/60"
            : "border-primary bg-accent"
          : "border-border hover:bg-accent/50",
        disabled && "cursor-not-allowed opacity-50",
        veil.className,
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className={cn("size-4", accent?.iconClassName)} />
        {title}
        {badge}
        {selected && <Check className="ml-auto size-4 text-primary" />}
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  );
}
