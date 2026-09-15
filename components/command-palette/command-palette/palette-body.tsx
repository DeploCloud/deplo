"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { BookOpen, ChevronDown, History, Search } from "lucide-react";

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandPrimitive,
} from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import type { Entry } from "@/lib/command-palette/entries";
import { gqlAction } from "@/lib/graphql-client";
import { DOCS_BASE } from "@/lib/docs";
import { PaletteEmptyGraphic } from "../palette-empty-graphic";
import { PaletteKbd } from "../palette-kbd";
import { closePalette } from "../palette-open";
import { useRecents } from "../use-recents";
import type { CommandPaletteProps } from "./palette-dialog";
import { EntryRow, HitRow, groupBy } from "./palette-rows";
import type { Hit } from "./search-hits";
import { useEntryMatches } from "./use-entry-matches";
import { useSearchResults } from "./use-search-results";

const DOCS_ROW = "docs:search";

const MORE_PAGES_ROW = "owned:more";

export function PaletteBody({
  userId,
  team,
  teams,
  breadcrumb,
  capabilities,
  isAdmin,
}: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const { recents, remember } = useRecents(userId, team.id);

  const {
    typing,
    matched,
    ownedMatched,
    hiddenPages,
    otherTeamPages,
    setExpandedPages,
  } = useEntryMatches({
    query,
    teams,
    teamId: team.id,
    breadcrumb,
    capabilities,
    isAdmin,
  });

  const { result, here, elsewhere, loading, failed } = useSearchResults(
    query,
    typing,
    team.id,
  );

  function runEntry(entry: Entry) {
    closePalette();
    if (entry.team) {
      void switchTeamAndGo(entry.team, entry.href);
      return;
    }
    remember({
      id: entry.id,
      label: entry.owner ? `${entry.owner.name} / ${entry.label}` : entry.label,
      href: entry.href,
    });
    router.push(entry.href);
  }

  function openHit(hit: Hit) {
    closePalette();
    remember({ id: hit.id, label: hit.label, href: hit.href });
    if (!hit.team || hit.team.id === team.id) {
      router.push(hit.href);
      return;
    }
    void switchTeamAndGo(hit.team, hit.href);
  }

  async function switchTeamAndGo(
    to: { id: string; name: string },
    href: string,
  ) {
    const res = await gqlAction(
      `mutation($teamId: String!) { switchTeam(teamId: $teamId) }`,
      { teamId: to.id },
    );
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`Switched to ${to.name}`);
    router.replace(href);
    router.refresh();
  }

  const showRecents = !query && recents.length > 0;
  const showDocs = typing;
  const nothing =
    otherTeamPages.length === 0 &&
    matched.length === 0 &&
    ownedMatched.length === 0 &&
    here.length === 0 &&
    elsewhere.length === 0;

  const rowIds = React.useMemo(
    () => [
      ...(showRecents ? recents.map((r) => `recent:${r.id}`) : []),
      ...matched.map((e) => e.id),
      ...here.map((h) => h.id),
      ...ownedMatched.map((e) => e.id),
      ...(hiddenPages > 0 ? [MORE_PAGES_ROW] : []),
      ...elsewhere.map((h) => h.id),
      ...otherTeamPages.map((e) => e.id),
      ...(showDocs ? [DOCS_ROW] : []),
    ],
    [
      showRecents,
      recents,
      matched,
      here,
      ownedMatched,
      hiddenPages,
      elsewhere,
      otherTeamPages,
      showDocs,
    ],
  );
  const userMoved = React.useRef(false);
  const [moved, setMoved] = React.useState<{ q: string; value: string } | null>(
    null,
  );
  const selected =
    moved && moved.q === query && rowIds.includes(moved.value)
      ? moved.value
      : (rowIds[0] ?? "");

  return (
    <Command
      shouldFilter={false}
      value={selected}
      onValueChange={(next) => {
        if (!userMoved.current) return;
        userMoved.current = false;
        setMoved({ q: query, value: next });
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <CommandPrimitive.Input
          value={query}
          onValueChange={setQuery}
          onKeyDown={(e) => {
            if (
              e.key === "ArrowDown" ||
              e.key === "ArrowUp" ||
              e.key === "Home" ||
              e.key === "End"
            ) {
              userMoved.current = true;
            }
          }}
          placeholder="Search"
          className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
      </div>

      <CommandList
        onMouseMove={() => {
          userMoved.current = true;
        }}
        style={{
          height: "min(calc(var(--cmdk-list-height) + 1rem), 24rem)",
        }}
        className="max-h-96 min-h-0 overscroll-contain p-2 transition-[height] duration-200 ease-out max-sm:h-auto! max-sm:max-h-none max-sm:flex-1 max-sm:transition-none"
      >
        {nothing && !loading && (
          <div className="flex flex-col items-center py-8 text-center">
            <PaletteEmptyGraphic className="mb-3" />
            <p className="text-sm">No results</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try an app name, a page, or a command.
            </p>
          </div>
        )}

        {showRecents && (
          <CommandGroup heading="Recent">
            {recents.map((r) => (
              <CommandItem
                key={r.id}
                value={`recent:${r.id}`}
                onSelect={() => {
                  closePalette();
                  router.push(r.href);
                }}
              >
                <History className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{r.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {groupBy(matched).map(([group, entries]) => (
          <CommandGroup key={group} heading={group}>
            {entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} onChoose={runEntry} />
            ))}
          </CommandGroup>
        ))}

        {groupBy(here).map(([group, rows]) => (
          <CommandGroup key={group} heading={group}>
            {rows.map((hit) => (
              <HitRow key={hit.id} hit={hit} onChoose={openHit} />
            ))}
          </CommandGroup>
        ))}

        {ownedMatched.length > 0 && (
          <CommandGroup heading="Pages">
            {ownedMatched.map((entry) => (
              <EntryRow key={entry.id} entry={entry} onChoose={runEntry} />
            ))}
            {hiddenPages > 0 && (
              <CommandItem
                value={MORE_PAGES_ROW}
                onSelect={() => setExpandedPages(query)}
              >
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-muted-foreground">
                  Show {hiddenPages} more
                </span>
              </CommandItem>
            )}
          </CommandGroup>
        )}

        {(elsewhere.length > 0 || otherTeamPages.length > 0) && (
          <CommandGroup heading="Other teams">
            {elsewhere.map((hit) => (
              <HitRow key={hit.id} hit={hit} onChoose={openHit} showTeam />
            ))}
            {otherTeamPages.map((entry) => (
              <EntryRow key={entry.id} entry={entry} onChoose={runEntry} />
            ))}
          </CommandGroup>
        )}

        {loading && result === null && (
          <CommandGroup heading="Resources">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="mx-1 my-1 h-9 rounded-md" />
            ))}
          </CommandGroup>
        )}

        {failed && (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            Couldn&rsquo;t search right now.
          </p>
        )}

        {showDocs && (
          <CommandGroup heading="Documentation">
            <CommandItem
              value={DOCS_ROW}
              onSelect={() => {
                closePalette();
                window.open(DOCS_BASE, "_blank", "noopener");
              }}
            >
              <BookOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">Search the documentation</span>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>

      <div
        aria-hidden
        className="flex h-11 shrink-0 items-center gap-4 border-t border-border bg-surface px-4 text-xs text-muted-foreground max-sm:hidden"
      >
        <Hint chord="↵" label="Select" />
        <span className="ml-auto flex items-center gap-1.5">
          <PaletteKbd />
          Close
        </span>
      </div>
    </Command>
  );
}

function Hint({ chord, label }: { chord: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="rounded border border-border bg-muted px-1 text-[10px]">
        {chord}
      </kbd>
      {label}
    </span>
  );
}
