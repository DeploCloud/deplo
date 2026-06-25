"use client";

import * as React from "react";
import { Check, Globe, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface TeamOption {
  id: string;
  name: string;
}

export interface ServerAccess {
  allTeams: boolean;
  teamIds: string[];
}

/**
 * Controlled editor for a server's team access — the "all teams / specific teams"
 * choice. Reused by the install dialog (initial choice) and the Settings → Servers
 * "Team access" dialog (post-install edit). Pure UI: the parent owns the value and
 * persists it (addServer / setServerTeams).
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
      <Label>Team access</Label>
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
          onSelect={() =>
            onChange({ allTeams: false, teamIds: value.teamIds })
          }
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
                <span className="truncate text-sm">{team.name}</span>
              </label>
            ))
          )}
        </div>
      )}
      {!value.allTeams && teams.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {selected.size === 0
            ? "No teams selected — no team can deploy here until you pick at least one."
            : `${selected.size} team${selected.size === 1 ? "" : "s"} selected.`}
        </p>
      )}
    </div>
  );
}

function AccessOption({
  icon: Icon,
  title,
  description,
  selected,
  disabled,
  onSelect,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-accent"
          : "border-border hover:bg-accent/50",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-4" />
        {title}
        {selected && <Check className="ml-auto size-4 text-primary" />}
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  );
}
