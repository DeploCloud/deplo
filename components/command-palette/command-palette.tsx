"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Box,
  BookOpen,
  Braces,
  Clock,
  FolderTree,
  Globe,
  History,
  Layers,
  LayoutTemplate,
  Search,
  Server,
  Users,
} from "lucide-react";

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandPrimitive,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { canSee } from "@/components/layout/nav-config";
import {
  appFrameEntries,
  dbFrameEntries,
  matchEntries,
  staticEntries,
  type Entry,
} from "@/lib/command-palette/entries";
import { gql, gqlAction } from "@/lib/graphql-client";
import { SEARCH_QUERY } from "@/lib/command-palette/search-query";
import { DOCS_BASE } from "@/lib/docs";
import { foldQuery } from "@/lib/match-query";
import {
  folderHref,
  placementHref,
  projectHref,
  templateHref,
} from "@/lib/overview-links";
import type { DatabaseType, TeamIdentity } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PaletteKbd } from "./palette-kbd";
import {
  closePalette,
  togglePalette,
  openPalette,
  usePaletteOpen,
} from "./palette-open";
import { useRecents } from "./use-recents";

/* ------------------------------------------------------------------ */
/* The server half                                                     */
/* ------------------------------------------------------------------ */

interface HitTeam {
  id: string;
  name: string;
}

interface SearchData {
  search: {
    apps: {
      id: string;
      name: string;
      slug: string;
      logo: string | null;
      productionUrl: string | null;
      team: HitTeam;
    }[];
    databases: {
      id: string;
      name: string;
      logo: string | null;
      type: DatabaseType;
      team: HitTeam;
    }[];
    servers: { id: string; name: string; host: string }[];
    projects: { id: string; name: string; team: HitTeam }[];
    environments: {
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      team: HitTeam;
    }[];
    folders: { id: string; name: string; team: HitTeam }[];
    domains: {
      id: string;
      name: string;
      appSlug: string;
      appName: string;
      team: HitTeam;
    }[];
    members: {
      userId: string;
      name: string;
      username: string;
      team: HitTeam;
    }[];
    cronJobs: {
      id: string;
      name: string;
      targetKind: string;
      targetRef: string;
      targetName: string;
      team: HitTeam;
    }[];
    templates: { slug: string; name: string; logo: string | null }[];
  };
}

/** A search hit, flattened into what a row needs. */
interface Hit {
  id: string;
  label: string;
  hint?: string;
  group: string;
  href: string;
  team: HitTeam | null;
  /** Choosing this opens its own menu instead of navigating. */
  frame?: Exclude<Frame, { kind: "root" }>;
  logo?:
    | { kind: "app"; logo: string | null }
    | { kind: "database"; logo: string | null; type: DatabaseType };
  icon?: React.ComponentType<{ className?: string }>;
}

function toHits(data: SearchData): Hit[] {
  const s = data.search;
  return [
    ...s.apps.map((a) => ({
      id: `app:${a.id}`,
      label: a.name,
      hint: a.slug,
      group: "Apps",
      href: `/apps/${a.slug}`,
      team: a.team,
      frame: {
        kind: "app" as const,
        id: a.id,
        slug: a.slug,
        name: a.name,
        logo: a.logo,
        productionUrl: a.productionUrl,
      },
      logo: { kind: "app" as const, logo: a.logo },
    })),
    ...s.databases.map((d) => ({
      id: `db:${d.id}`,
      label: d.name,
      hint: d.type,
      group: "Databases",
      href: `/storage/databases/${d.id}`,
      team: d.team,
      frame: {
        kind: "database" as const,
        id: d.id,
        name: d.name,
        logo: d.logo,
        type: d.type,
      },
      logo: { kind: "database" as const, logo: d.logo, type: d.type },
    })),
    ...s.servers.map((v) => ({
      id: `server:${v.id}`,
      label: v.name,
      hint: v.host,
      group: "Servers",
      href: `/settings/servers/${v.id}`,
      team: null,
      icon: Server,
    })),
    ...s.projects.map((p) => ({
      id: `project:${p.id}`,
      label: p.name,
      group: "Projects",
      href: projectHref(p.id),
      team: p.team,
      icon: Layers,
    })),
    ...s.environments.map((e) => ({
      id: `env:${e.id}`,
      label: e.name,
      hint: e.projectName,
      group: "Environments",
      href: placementHref({ projectId: e.projectId, environmentId: e.id }),
      team: e.team,
      icon: Braces,
    })),
    ...s.folders.map((f) => ({
      id: `folder:${f.id}`,
      label: f.name,
      group: "Folders",
      href: folderHref(f.id),
      team: f.team,
      icon: FolderTree,
    })),
    ...s.domains.map((d) => ({
      id: `domain:${d.id}`,
      label: d.name,
      hint: d.appName,
      group: "Domains",
      href: `/apps/${d.appSlug}/domains`,
      team: d.team,
      icon: Globe,
    })),
    ...s.members.map((m) => ({
      id: `member:${m.team.id}:${m.userId}`,
      label: m.name,
      hint: m.username,
      group: "Members",
      href: `/settings/members/${m.userId}`,
      team: m.team,
      icon: Users,
    })),
    ...s.cronJobs.map((c) => ({
      id: `cron:${c.id}`,
      label: c.name,
      hint: c.targetName,
      group: "Cron jobs",
      href:
        c.targetKind === "database"
          ? `/storage/databases/${c.targetRef}/cron-jobs`
          : `/apps/${c.targetRef}/cron-jobs`,
      team: c.team,
      icon: Clock,
    })),
    ...s.templates.map((t) => ({
      id: `template:${t.slug}`,
      label: t.name,
      group: "Templates",
      href: templateHref(t.slug),
      team: null,
      icon: LayoutTemplate,
    })),
  ];
}

/* ------------------------------------------------------------------ */
/* Frames                                                              */
/* ------------------------------------------------------------------ */

type Frame =
  | { kind: "root" }
  | {
      kind: "app";
      id: string;
      slug: string;
      name: string;
      logo: string | null;
      productionUrl: string | null;
    }
  | {
      kind: "database";
      id: string;
      name: string;
      logo: string | null;
      type: DatabaseType;
    };

const ROOT: Frame = { kind: "root" };

/* ------------------------------------------------------------------ */
/* The palette                                                         */
/* ------------------------------------------------------------------ */

export interface CommandPaletteProps {
  userId: string;
  team: TeamIdentity;
  capabilities: string[];
  isAdmin: boolean;
}

export function CommandPalette(props: CommandPaletteProps) {
  const open = usePaletteOpen();

  // ⌘K / Ctrl K works ANYWHERE, a field included - that is the point of it.
  // "/" keeps the contract it had in the sidebar: never while typing.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        togglePalette();
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true']"))
          return;
        e.preventDefault();
        openPalette();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closePalette()}>
      <DialogContent
        selfManaged
        hideClose
        className={cn(
          // Beat the base centring: tailwind-merge lets the later class win.
          "top-[12vh] flex max-w-2xl translate-y-0 flex-col gap-0 overflow-hidden p-0",
          // Full screen on a phone, where this is the only search there is.
          "max-sm:inset-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-none max-sm:border-0",
        )}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search apps, pages, settings and actions
        </DialogDescription>
        {/* Mounted only while open, so every frame and query resets by itself. */}
        {open && <PaletteBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({
  userId,
  team,
  capabilities,
  isAdmin,
}: CommandPaletteProps) {
  const router = useRouter();
  const [stack, setStack] = React.useState<Frame[]>([ROOT]);
  const [query, setQuery] = React.useState("");
  // One piece of state, carrying the query it answered: "still in flight" and
  // "that one failed" are then derived, so nothing has to be reset by hand.
  const [result, setResult] = React.useState<{
    q: string;
    rows: Hit[];
  } | null>(null);
  const [failedQuery, setFailedQuery] = React.useState<string | null>(null);
  const { recents, remember } = useRecents(userId, team.id);

  const frame = stack[stack.length - 1] ?? ROOT;
  const caps = React.useMemo(() => new Set(capabilities), [capabilities]);

  const push = (next: Frame) => {
    setStack((s) => [...s, next]);
    setQuery("");
  };
  const pop = () => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    setQuery("");
  };

  /* -- the static half, matched in the bundle -- */

  const catalogue = React.useMemo(() => {
    const all =
      frame.kind === "app"
        ? appFrameEntries(frame)
        : frame.kind === "database"
          ? dbFrameEntries(frame)
          : staticEntries();
    return all.filter((e) => canSee(e, caps, isAdmin));
  }, [frame, caps, isAdmin]);

  const matched = React.useMemo(
    () => matchEntries(catalogue, query),
    [catalogue, query],
  );

  /* -- the server half, debounced -- */

  // A frame is about one resource: searching the fleet from inside it would walk
  // you out of the thing you just opened.
  const searching = frame.kind === "root" && Boolean(foldQuery(query));

  React.useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const data = await gql<SearchData>(
          SEARCH_QUERY,
          { q: query },
          controller.signal,
        );
        setResult({ q: query, rows: toHits(data) });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setFailedQuery(query);
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searching]);

  const answered = result?.q === query;
  const failed = failedQuery === query;
  // The previous query's rows stay while the next one is in flight: they are for
  // a prefix of what is being typed, and swapping them for skeletons on every
  // keystroke makes the list strobe.
  const loading = searching && !answered && !failed;

  const [here, elsewhere] = React.useMemo(() => {
    const rows = searching ? (result?.rows ?? []) : [];
    return [
      rows.filter((h) => !h.team || h.team.id === team.id),
      rows.filter((h) => h.team && h.team.id !== team.id),
    ];
  }, [result, searching, team.id]);

  /* -- choosing a row -- */

  async function runEntry(entry: Entry) {
    if (entry.run.kind === "href") {
      remember({
        id: entry.id,
        label: entry.label,
        href: entry.run.href,
        kind: "nav",
      });
    }
    closePalette();
    switch (entry.run.kind) {
      case "href":
        if (entry.run.newTab) window.open(entry.run.href, "_blank", "noopener");
        else router.push(entry.run.href);
        return;
      case "copy":
        await navigator.clipboard.writeText(entry.run.text);
        toast.success("Copied");
        return;
      case "mutation": {
        const res = await gqlAction(entry.run.query, entry.run.variables);
        if (res.ok) {
          toast.success(entry.run.success);
          router.refresh();
        } else {
          toast.error(res.error);
        }
        return;
      }
    }
  }

  function openHit(hit: Hit) {
    if (hit.frame && (!hit.team || hit.team.id === team.id)) {
      // Entering a resource is using it.
      remember({
        id: hit.id,
        label: hit.label,
        href: hit.href,
        kind: hit.frame.kind,
      });
      push(hit.frame);
      return;
    }
    closePalette();
    if (!hit.team || hit.team.id === team.id) {
      router.push(hit.href);
      return;
    }
    void switchTeamAndGo(hit.team, hit.href);
  }

  async function switchTeamAndGo(to: HitTeam, href: string) {
    const res = await gqlAction(
      `mutation($teamId: String!) { switchTeam(teamId: $teamId) }`,
      { teamId: to.id },
    );
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`Switched to ${to.name}`);
    // REPLACE, never push: the entry we would leave behind points at the team we
    // just left, so "back" would land on a page that no longer resolves.
    router.replace(href);
    router.refresh();
  }

  /* -- rendering -- */

  const showRecents = frame.kind === "root" && !query && recents.length > 0;
  const nothing =
    matched.length === 0 && here.length === 0 && elsewhere.length === 0;

  return (
    <Command shouldFilter={false} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        {frame.kind !== "root" && (
          <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2 text-xs text-secondary-foreground">
            {frame.kind === "app" ? (
              <AppLogo logo={frame.logo} size={14} />
            ) : (
              <DatabaseLogo type={frame.type} logo={frame.logo} size={14} />
            )}
            <span className="max-w-32 truncate">{frame.name}</span>
          </span>
        )}
        <CommandPrimitive.Input
          value={query}
          onValueChange={setQuery}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && query === "" && stack.length > 1) {
              e.preventDefault();
              pop();
              return;
            }
            // Escape rises one frame before it closes anything; stopped here so
            // Radix never sees the ones that are not a close.
            if (e.key === "Escape" && stack.length > 1) {
              e.preventDefault();
              e.stopPropagation();
              pop();
            }
          }}
          placeholder={
            frame.kind === "root" ? "Search" : `Search in ${frame.name}`
          }
          // 16px, because iOS Safari zooms a focused field under it and this
          // opens full screen there.
          className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* Keyed on the depth: a frame swap remounts the LIST, so cmdk's item
          registry does not carry rows across it - and not the input, which
          would lose focus the moment you stepped into an app. */}
      <CommandList
        key={stack.length}
        className="min-h-0 flex-1 overscroll-contain p-2 sm:max-h-96"
      >
        {/* Ours, not cmdk's CommandEmpty: that one counts MOUNTED items, and
            the documentation row below is always one of them. */}
        {nothing && !loading && (
          <div className="py-10 text-center">
            <p className="text-sm">No results for &ldquo;{query}&rdquo;</p>
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
                value={r.id}
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
              <CommandItem
                key={entry.id}
                value={entry.id}
                onSelect={() => void runEntry(entry)}
              >
                <entry.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.label}</span>
                {entry.hint && (
                  <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                    {entry.hint}
                  </span>
                )}
              </CommandItem>
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

        {elsewhere.length > 0 && (
          <CommandGroup heading="Other teams">
            {elsewhere.map((hit) => (
              <HitRow key={hit.id} hit={hit} onChoose={openHit} showTeam />
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

        {frame.kind === "root" && query && (
          <CommandGroup heading="Documentation">
            <CommandItem
              value="docs:search"
              onSelect={() => {
                closePalette();
                // The manual has its own search, on the same chord. It does not
                // read a query out of the URL, so do not promise one here.
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
        className="flex h-11 shrink-0 items-center gap-4 border-t border-border bg-muted/30 px-4 text-xs text-muted-foreground max-sm:hidden"
      >
        <Hint chord="↵" label="Select" />
        {stack.length > 1 && <Hint chord="⌫" label="Back" />}
        <span className="ml-auto flex items-center gap-1.5">
          <PaletteKbd />
          Close
        </span>
      </div>
    </Command>
  );
}

/** Rows in the order they arrived, gathered under their group heading. */
function groupBy<T extends { group: string }>(rows: T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.group);
    if (list) list.push(row);
    else out.set(row.group, [row]);
  }
  return [...out];
}

function HitRow({
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
      ) : (
        <Icon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{hit.label}</span>
      <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
        {showTeam && hit.team ? hit.team.name : hit.hint}
      </span>
    </CommandItem>
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
