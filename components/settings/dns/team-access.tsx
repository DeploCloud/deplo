"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";

export interface DnsTeam {
  id: string;
  name: string;
  slug: string;
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
  return (
    <div className="w-full space-y-4 text-left">
      <div
        role="group"
        aria-label="Teams"
        className="divide-y divide-border rounded-lg border border-border"
      >
        {teams.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">
            You don&apos;t manage domains in any team.
          </p>
        )}
        {teams.map((t) => {
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
