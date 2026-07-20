"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Box,
  Boxes,
  Check,
  ChevronDown,
  Folder as FolderIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppNav } from "@/components/apps/app-nav-store";
import {
  buildBreadcrumb,
  type BreadcrumbGraph,
  type BreadcrumbSegment,
  type DropItem,
} from "@/lib/breadcrumb-model";
import { cn } from "@/lib/utils";

/** Keep the crumb trail from crowding out the header on a deeply nested path:
 *  beyond this many folder crumbs the middle ones fold into a single "…" menu
 *  (Windows-Explorer behaviour). */
const MAX_FOLDER_CRUMBS = 3;

/**
 * The topbar breadcrumb. On an apps-tree location — browsing a folder/project
 * on the Overview, or anywhere inside an app — it renders
 * "Overview ▾ / Folder ▾ / App ▾ / Section ▾", where clicking a name navigates
 * and the ▾ opens a menu of sibling targets (hop between apps in the same
 * folder, pivot into a sibling subfolder, jump to another section). On any other
 * route it renders the caller's `fallback` label unchanged.
 */
export function Breadcrumbs({
  pathname,
  graph,
  capabilities,
  fallback,
}: {
  pathname: string;
  graph: BreadcrumbGraph;
  capabilities: string[];
  /** Plain label shown (after a "/") when there's no rich trail to build. */
  fallback: string;
}) {
  // The Overview drill-in lives in the query string (?folder=/?project=/?view=),
  // which layouts don't receive — so the topbar reads it client-side. During a
  // search (?q=) the Overview shows flat results with no folder open, so we drop
  // the folder/project context to match.
  const params = useSearchParams();
  const searching = Boolean(params.get("q"));
  const openFolderId = searching ? null : params.get("folder");
  const openProjectId = searching ? null : params.get("project");
  const view = params.get("view") === "list" ? "list" : "grid";

  // Live per-app facts (Console/Files visibility) — null until the app
  // layout publishes them, so the section menus fill in after first paint. The
  // sibling/folder menus need none of this and are complete from SSR.
  const service = useAppNav();
  const slug = pathname.match(/^\/apps\/([^/]+)/)?.[1] ?? null;

  const caps = React.useMemo(() => {
    const set = new Set(capabilities);
    return {
      manageEnv: set.has("manage_env"),
      manageInfra: set.has("manage_infra"),
      manageDomains: set.has("manage_domains"),
    };
  }, [capabilities]);

  const segments = buildBreadcrumb(
    { pathname, openFolderId, openProjectId, view },
    graph,
    caps,
    {
      running: service?.running ?? false,
      showFiles: service?.showFiles ?? false,
      slugMatches: service?.slug === slug,
    },
  );

  if (!segments) {
    return (
      <span className="hidden items-center gap-2 sm:flex">
        <span className="text-muted-foreground/40">/</span>
        <span className="text-sm text-muted-foreground">{fallback}</span>
      </span>
    );
  }

  const display = collapseFolders(segments);

  return (
    <nav
      aria-label="Breadcrumb"
      className="hidden min-w-0 items-center gap-1 text-sm sm:flex"
    >
      {display.map((seg, i) => (
        <React.Fragment key={seg.key}>
          <span className="shrink-0 text-muted-foreground/40">/</span>
          {seg.key === "__ellipsis__" ? (
            <EllipsisCrumb segment={seg} />
          ) : (
            <Crumb segment={seg} isCurrent={i === display.length - 1} />
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

/** Fold the middle of a long folder run into one "…" crumb (see MAX_FOLDER_CRUMBS). */
function collapseFolders(segments: BreadcrumbSegment[]): BreadcrumbSegment[] {
  const folderIdx = segments
    .map((s, i) => (s.kind === "folder" ? i : -1))
    .filter((i) => i >= 0);
  if (folderIdx.length <= MAX_FOLDER_CRUMBS) return segments;
  // Folder crumbs are contiguous (root → leaf); keep the first + last, fold the
  // rest — everything before the run (the Overview crumb) and after it is kept.
  const first = folderIdx[0];
  const last = folderIdx[folderIdx.length - 1];
  const middle = segments.slice(first + 1, last);
  const ellipsis: BreadcrumbSegment = {
    key: "__ellipsis__",
    name: "…",
    href: middle[middle.length - 1].href,
    kind: "folder",
    items: middle.map((s) => ({
      id: s.key,
      label: s.name,
      href: s.href,
      kind: "folder" as const,
      current: false,
    })),
  };
  return [...segments.slice(0, first + 1), ellipsis, ...segments.slice(last)];
}

/** A name that links to its level, plus a ▾ menu of sibling/child targets. */
function Crumb({
  segment,
  isCurrent,
}: {
  segment: BreadcrumbSegment;
  /** The last crumb — the page you're on (gets aria-current + foreground text). */
  isCurrent?: boolean;
}) {
  const hasChoices = segment.items.some((i) => !i.current);
  return (
    <span className="flex min-w-0 items-center">
      <Link
        href={segment.href}
        title={segment.name}
        aria-current={isCurrent ? "page" : undefined}
        className={cn(
          "max-w-40 truncate rounded px-1 py-0.5 transition-colors hover:bg-accent/60 hover:text-foreground",
          isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {segment.name}
      </Link>
      {hasChoices && <SiblingMenu segment={segment} />}
    </span>
  );
}

/** The collapsed "…" crumb — the whole thing is the menu trigger (no link). */
function EllipsisCrumb({ segment }: { segment: BreadcrumbSegment }) {
  return (
    <span className="flex items-center">
      <SiblingMenu segment={segment} label="…" />
    </span>
  );
}

function SiblingMenu({
  segment,
  label,
}: {
  segment: BreadcrumbSegment;
  /** When set, the trigger shows this text instead of a bare chevron. */
  label?: string;
}) {
  // Bucket items under their optional group heading, preserving order.
  const groups: { name?: string; items: DropItem[] }[] = [];
  for (const it of segment.items) {
    const g = groups.find((x) => x.name === it.group);
    if (g) g.items.push(it);
    else groups.push({ name: it.group, items: [it] });
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Switch ${segment.name}`}
          className={cn(
            "flex shrink-0 items-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
            label ? "px-1 py-0.5 text-muted-foreground" : "p-0.5",
          )}
        >
          {label && <span className="mr-0.5">{label}</span>}
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[70vh] w-56 overflow-y-auto"
      >
        {groups.map((grp, gi) => (
          <React.Fragment key={grp.name ?? gi}>
            {gi > 0 && <DropdownMenuSeparator />}
            {grp.name && (
              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                {grp.name}
              </DropdownMenuLabel>
            )}
            {grp.items.map((it) => (
              <MenuRow key={it.id} item={it} />
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuRow({ item }: { item: DropItem }) {
  const Icon =
    item.kind === "folder"
      ? FolderIcon
      : item.kind === "project"
        ? Boxes
        : item.kind === "app"
          ? Box
          : null;
  if (item.current) {
    // The entry you're already on: a non-navigating marker, kept full-opacity
    // (the variant-scoped override beats the base data-[disabled]:opacity-50).
    return (
      <DropdownMenuItem
        disabled
        aria-current="true"
        className="data-[disabled]:opacity-100"
      >
        {Icon && <Icon className="size-4 text-muted-foreground" />}
        <span className="truncate">{item.label}</span>
        <span className="sr-only">(current)</span>
        <Check className="ml-auto size-4 text-muted-foreground" />
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem asChild className="cursor-pointer">
      <Link href={item.href}>
        {Icon && <Icon className="size-4 text-muted-foreground" />}
        <span className="truncate">{item.label}</span>
      </Link>
    </DropdownMenuItem>
  );
}
