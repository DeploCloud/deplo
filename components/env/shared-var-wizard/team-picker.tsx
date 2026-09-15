"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { TeamAvatar } from "@/components/shared/user-avatar";
import type { TeamRef } from "./types";
import { PickerSearch } from "./picker-search";

export function TeamsSection({
  teams,
  locked = [],
  selected,
  onChange,
}: {
  teams: TeamRef[];
  locked?: TeamRef[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [q, setQ] = React.useState("");
  const match = <T extends { name: string }>(rows: T[]): T[] => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((t) => t.name.toLowerCase().includes(needle));
  };
  const shown = match(teams);
  const shownLocked = match(locked);
  const set = new Set(selected);

  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-medium">Teams</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick one and each app adds it explicitly. Pick two or more and it is
          added to every app in all of them.{" "}
          {selected.length > 0 && `${selected.length} selected.`}
        </p>
      </div>
      <PickerSearch
        value={q}
        onChange={setQ}
        placeholder="Search teams"
        label="Search teams"
      />
      {shown.length === 0 && shownLocked.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No team matches &ldquo;{q.trim()}&rdquo;.
        </p>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {shownLocked.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-3 px-3 py-2.5 opacity-60"
          >
            <Checkbox checked disabled />
            <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="lg" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {t.name}
            </span>
            <span className="text-xs text-muted-foreground">
              Already shared
            </span>
          </div>
        ))}
        {shown.map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface"
          >
            <Checkbox
              checked={set.has(t.id)}
              onCheckedChange={(c) =>
                onChange(
                  c === true
                    ? [...selected, t.id]
                    : selected.filter((id) => id !== t.id),
                )
              }
            />
            <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="lg" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {t.name}
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
