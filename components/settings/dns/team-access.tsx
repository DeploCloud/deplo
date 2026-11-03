"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { TeamAvatar } from "@/components/shared/user-avatar";

export interface DnsTeam {
  id: string;
  name: string;
  slug: string;
  avatarUrl?: string | null;
}

export function matchTeams(teams: DnsTeam[], query: string): DnsTeam[] {
  const q = query.trim().toLowerCase();
  if (!q) return teams;
  return teams.filter(
    (t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q),
  );
}

/** Which teams may use a connected domain, and whether everyone in them may, or only its owner. */
export function TeamAccess({
  idPrefix,
  teams,
  selected,
  shared,
  onSelected,
  onShared,
}: {
  idPrefix: string;
  teams: DnsTeam[];
  selected: string[];
  shared: boolean;
  onSelected: (ids: string[]) => void;
  onShared: (shared: boolean) => void;
}) {
  const [query, setQuery] = React.useState("");
  const shown = matchTeams(teams, query);
  return (
    <div className="w-full space-y-3 text-left">
      {teams.length > 0 && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={`${idPrefix}-team-search`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teams"
            aria-label="Search teams"
            autoComplete="off"
            className="pl-9"
          />
        </div>
      )}
      <div
        role="group"
        aria-label="Teams"
        className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border"
      >
        {teams.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">
            You don&apos;t manage domains in any team.
          </p>
        )}
        {teams.length > 0 && shown.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">
            No team matches your search.
          </p>
        )}
        {shown.map((t) => {
          const id = `${idPrefix}-team-${t.id}`;
          const checked = selected.includes(t.id);
          return (
            <label
              key={t.id}
              htmlFor={id}
              className="flex cursor-pointer items-center gap-3 p-3 transition-colors hover:bg-accent"
            >
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(c) =>
                  onSelected(
                    c === true
                      ? [...selected, t.id]
                      : selected.filter((s) => s !== t.id),
                  )
                }
              />
              <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="md" />
              <span className="min-w-0 flex-1 truncate text-sm">{t.name}</span>
            </label>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
        <FieldLabel
          htmlFor={`${idPrefix}-shared`}
          className="cursor-pointer font-normal"
          info="Off, only you get automatic DNS. On, every member of these teams who can add domains does too, with your API token."
          docs="domains.automaticDnsAccess"
        >
          Anyone in these teams can use it
        </FieldLabel>
        <Switch
          id={`${idPrefix}-shared`}
          checked={shared}
          onCheckedChange={onShared}
        />
      </div>
    </div>
  );
}
