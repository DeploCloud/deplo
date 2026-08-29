"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Box,
  BookOpen,
  ChevronDown,
  Braces,
  Clock,
  FolderTree,
  Globe,
  History,
  Layers,
  LayoutTemplate,
  Search,
  Server,
  ShieldCheck,
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
import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { canSee } from "@/components/layout/nav-config";
import {
  appFrameEntries,
  dbFrameEntries,
  countOwnedPages,
  matchEntries,
  matchOwnedPages,
  ownedPageEntries,
  teamPageEntries,
  staticEntries,
  type Entry,
  type EntryOwner,
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
import type { BreadcrumbGraph } from "@/lib/breadcrumb-model";
import type { DatabaseType, TeamIdentity } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PaletteEmptyGraphic } from "./palette-empty-graphic";
import { PaletteKbd } from "./palette-kbd";
import {
  closePalette,
  togglePalette,
  openPalette,
  usePaletteGeneration,
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
      avatarUrl: string | null;
      avatarColor: string;
      team: HitTeam;
    }[];
    roles: { id: string; name: string; memberCount: number; team: HitTeam }[];
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
    | { kind: "database"; logo: string | null; type: DatabaseType }
    | { kind: "person"; name: string; avatarUrl: string | null; color: string }
    | { kind: "team"; name: string; avatarUrl: string | null };
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
      logo: {
        kind: "person" as const,
        name: m.name,
        avatarUrl: m.avatarUrl,
        color: m.avatarColor,
      },
    })),
    ...s.roles.map((r) => ({
      id: `role:${r.id}`,
      label: r.name,
      hint: `${r.memberCount} ${r.memberCount === 1 ? "member" : "members"}`,
      group: "Roles",
      href: `/settings/roles/${r.id}`,
      team: r.team,
      icon: ShieldCheck,
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

/** The always-last row, named because the highlight logic has to know it. */
const DOCS_ROW = "docs:search";

/** The row that opens the rest of them. */
const MORE_PAGES_ROW = "owned:more";

/** How many of one resource's pages are shown before the palette offers the rest. */
const OWNED_CAP = 6;

/* ------------------------------------------------------------------ */
/* The palette                                                         */
/* ------------------------------------------------------------------ */

export interface CommandPaletteProps {
  userId: string;
  team: TeamIdentity;
  /** Every team the caller can reach - the topbar's switcher already has them. */
  teams: { id: string; name: string; avatarUrl?: string | null }[];
  /** The team's apps and databases, already in the browser for the breadcrumb. */
  breadcrumb: BreadcrumbGraph;
  capabilities: string[];
  isAdmin: boolean;
}

export function CommandPalette(props: CommandPaletteProps) {
  const open = usePaletteOpen();
  const generation = usePaletteGeneration();

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
        // Heavier than the house dialog's: the palette covers the whole page
        // and the blur is what says the rest of it is out of play.
        overlayClassName="bg-black/60 backdrop-blur-lg"
        className={cn(
          // Beat the base centring: tailwind-merge lets the later class win.
          "top-[12vh] flex max-w-2xl translate-y-0 flex-col gap-0 overflow-hidden p-0",
          // The card is glass too, not only the page behind it.
          "bg-background/30 backdrop-blur-xl",
          // Full screen on a phone, where this is the only search there is.
          "max-sm:inset-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-none max-sm:border-0",
        )}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search apps, pages, settings and actions
        </DialogDescription>
        {/* NOT gated on `open`: Radix unmounts these children itself once the
            closing animation ends, and gating emptied the card the instant you
            hit Escape - a blurred pane with nothing in it. Keyed on the opening
            instead, so a re-open that beats the animation still starts clean. */}
        <PaletteBody key={generation} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({
  userId,
  team,
  teams,
  breadcrumb,
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

  // "deployments" reaches every app's own Deployments page, and "deplo
  // variables" narrows to one - without stepping into the app first. Built off
  // the breadcrumb snapshot, so no extra request, and only once something has
  // been typed, since this is a dozen rows per app.
  const typing = frame.kind === "root" && Boolean(foldQuery(query));
  const owned = React.useMemo(
    () =>
      typing ? ownedPageEntries(breadcrumb.apps, breadcrumb.databases) : [],
    [breadcrumb, typing],
  );
  const visibleOwned = React.useMemo(
    () => owned.filter((e) => canSee(e, caps, isAdmin)),
    [owned, caps, isAdmin],
  );
  // Reset with the query and with the frame, exactly like the highlight.
  const [expandedPages, setExpandedPages] = React.useState<string | null>(null);
  const pagesExpanded = expandedPages === query;
  const ownedTotal = React.useMemo(
    () => countOwnedPages(visibleOwned, query),
    [visibleOwned, query],
  );
  const ownedMatched = React.useMemo(
    () =>
      matchOwnedPages(
        visibleOwned,
        query,
        pagesExpanded ? Number.POSITIVE_INFINITY : OWNED_CAP,
      ),
    [visibleOwned, query, pagesExpanded],
  );
  const hiddenPages = ownedTotal - ownedMatched.length;

  // The same team pages, once for every other team the caller can reach: the
  // palette is cross-team for apps, and settings were the odd one out.
  // `caps` is the ACTIVE team's, so a page can be filtered by a capability held
  // somewhere else - a UX approximation, like every other check here. The gate
  // that counts is `requireCapability`, in the data layer, per team.
  const otherTeamPages = React.useMemo(
    () =>
      frame.kind === "root" && query
        ? matchEntries(
            teamPageEntries(teams, team.id).filter((e) =>
              canSee(e, caps, isAdmin),
            ),
            query,
          )
        : [],
    [frame.kind, query, teams, team.id, caps, isAdmin],
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
    if (entry.team && entry.run.kind === "href") {
      closePalette();
      await switchTeamAndGo(entry.team, entry.run.href);
      return;
    }
    if (entry.run.kind === "href") {
      remember({
        id: entry.id,
        // A page of an app is remembered WITH the app: "Environment" on its own
        // says nothing about whose it was.
        label: entry.owner
          ? `${entry.owner.name} / ${entry.label}`
          : entry.label,
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
  const showDocs = frame.kind === "root" && Boolean(query);
  const nothing =
    otherTeamPages.length === 0 &&
    matched.length === 0 &&
    ownedMatched.length === 0 &&
    here.length === 0 &&
    elsewhere.length === 0;

  /*
   * cmdk keeps a selection that still exists, and the documentation row exists
   * from the first keystroke - so typing an app name selected THAT, and the app
   * itself arriving 250ms later changed nothing. Own the highlight instead: the
   * first row, unless the person moved off it themselves within this query.
   */
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
  // cmdk also fires onValueChange when it re-selects on its own; only a real
  // arrow key or a pointer over the list counts as moving.
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
              return;
            }
            if (
              e.key === "ArrowDown" ||
              e.key === "ArrowUp" ||
              e.key === "Home" ||
              e.key === "End"
            ) {
              userMoved.current = true;
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
        onMouseMove={() => {
          userMoved.current = true;
        }}
        // cmdk measures its own content into --cmdk-list-height; +1rem is this
        // element's own p-2, since the box is border-box. NO fallback on
        // purpose: until cmdk has measured, the whole declaration is invalid and
        // the height stays `auto`. With one (`0px`) the list opened a sliver
        // tall, cmdk scrolled the selected row into that sliver, and the list
        // stayed scrolled past "Recent" once it grew. max-h-96 caps that first
        // frame. Full height on a phone, where the palette owns the screen.
        style={{
          height: "min(calc(var(--cmdk-list-height) + 1rem), 24rem)",
        }}
        className="max-h-96 min-h-0 overscroll-contain p-2 transition-[height] duration-200 ease-out max-sm:h-auto! max-sm:max-h-none max-sm:flex-1 max-sm:transition-none"
      >
        {/* Ours, not cmdk's CommandEmpty: that one counts MOUNTED items, and
            the documentation row below is always one of them. */}
        {nothing && !loading && (
          <div className="flex flex-col items-center py-8 text-center">
            <PaletteEmptyGraphic className="mb-3" />
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

/** Only the verbs that act on a running container are coloured; red stays for
 *  a failure, never for a control. */
const TONE = {
  info: "text-[var(--info)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  violet: "text-[var(--violet)]",
} as const;

function EntryRow({
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
        <entry.icon
          className={cn(
            "size-4 shrink-0",
            entry.tone ? TONE[entry.tone] : "text-muted-foreground",
          )}
        />
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

/**
 * The resource's own logo, badged with the page's glyph: at a glance this is
 * deplo-web's Environment page, not deplo's own.
 */
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

/** Whose page this is, with the page's own glyph badged onto it. */
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
      ) : hit.logo?.kind === "person" ? (
        <UserAvatar
          name={hit.logo.name}
          avatarUrl={hit.logo.avatarUrl}
          avatarColor={hit.logo.color}
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
