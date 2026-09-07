"use client";

import { Plus } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TeamAvatar } from "@/components/shared/user-avatar";
import type { TeamTarget } from "./queue";
import type { TargetTeam } from "./types";

const NEW_TEAM = "new";

/**
 * Where one source team lands: a team that exists, or one named after it. The
 * namesake is the default (see `defaultTarget`); this is the way to say otherwise.
 */
export function TargetSelect({
  value,
  teams,
  sourceName,
  disabled,
  onChange,
}: {
  value: TeamTarget;
  teams: TargetTeam[];
  /** What the new team would be called. */
  sourceName: string;
  disabled: boolean;
  onChange: (target: TeamTarget) => void;
}) {
  return (
    <Select
      value={value.kind === "new" ? NEW_TEAM : value.teamId}
      onValueChange={(v) =>
        onChange(
          v === NEW_TEAM ? { kind: "new" } : { kind: "existing", teamId: v },
        )
      }
      disabled={disabled}
    >
      <SelectTrigger
        className="w-[10rem]"
        aria-label={`Where ${sourceName} lands`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {teams.length > 0 && (
          <SelectGroup>
            <SelectLabel>Existing teams</SelectLabel>
            {teams.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                <span className="flex items-center gap-2">
                  <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="xs" />
                  <span className="truncate">{t.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        <SelectItem value={NEW_TEAM}>
          <span className="flex items-center gap-2">
            <Plus className="size-4 text-muted-foreground" />
            <span className="truncate">New team</span>
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
