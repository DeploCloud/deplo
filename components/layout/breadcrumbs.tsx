"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useSearchParams } from "next/navigation";
import {
  Boxes,
  Check,
  ChevronDown,
  Database as DatabaseIcon,
  Folder as FolderIcon,
  House,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { useAppNav } from "@/components/apps/app-nav-store";
import type { DatabaseType } from "@/lib/types/database";
import {
  buildBreadcrumb,
  type BreadcrumbGraph,
  type BreadcrumbSegment,
  type DropItem,
} from "@/lib/breadcrumb-model";
import { cn } from "@/lib/utils";

const MAX_FOLDER_CRUMBS = 3;

// Breadcrumbs - the topbar breadcrumb.
export function Breadcrumbs({
  pathname,
  graph,
  capabilities,
  fallback,
}: {
  pathname: string;
  graph: BreadcrumbGraph;
  capabilities: string[];
  fallback: string;
}) {
  const params = useSearchParams();
  const searching = Boolean(params.get("q"));
  const openFolderId = searching ? null : params.get("folder");
  const openProjectId = searching ? null : params.get("project");
  const view = params.get("view") === "list" ? "list" : "grid";

  const service = useAppNav();
  const slug = pathname.match(/^\/apps\/([^/]+)/)?.[1] ?? null;

  const appCaps = service?.slug === slug ? service.capabilities : null;
  const capKey = appCaps ? appCaps.join(",") : capabilities.join(",");
  const caps = React.useMemo(() => {
    const set = new Set(capKey ? capKey.split(",") : []);
    return {
      manageEnv: set.has("manage_env"),
      manageBackups: set.has("manage_backups"),
      manageBasicAuth: set.has("manage_basic_auth"),
      managePreviews: set.has("manage_previews"),
    };
  }, [capKey]);

  const segments = buildBreadcrumb(
    { pathname, openFolderId, openProjectId, view },
    graph,
    caps,
    {
      running: service?.running ?? false,
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

function collapseFolders(segments: BreadcrumbSegment[]): BreadcrumbSegment[] {
  const folderIdx = segments
    .map((s, i) => (s.kind === "folder" ? i : -1))
    .filter((i) => i >= 0);
  if (folderIdx.length <= MAX_FOLDER_CRUMBS) return segments;
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

function Crumb({
  segment,
  isCurrent,
}: {
  segment: BreadcrumbSegment;
  isCurrent?: boolean;
}) {
  const hasChoices = segment.items.some((i) => !i.current);
  const home = segment.kind === "overview" && !isCurrent;
  return (
    <span className="flex min-w-0 items-center">
      <Link
        href={segment.href}
        title={segment.name}
        aria-label={home ? segment.name : undefined}
        aria-current={isCurrent ? "page" : undefined}
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-surface-strong hover:text-foreground",
          isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {/* The thing's own mark, before its name. */}
        {home ? (
          <House className="size-3.5 shrink-0" />
        ) : (
          <>
            <KindIcon
              kind={segment.kind}
              logo={segment.logo}
              dbType={segment.dbType}
              size={14}
            />
            <span className="max-w-40 truncate">{segment.name}</span>
          </>
        )}
      </Link>
      {hasChoices && <SiblingMenu segment={segment} />}
    </span>
  );
}

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
  label?: string;
}) {
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

function KindIcon({
  kind,
  logo,
  dbType,
  size = 16,
}: {
  kind: DropItem["kind"] | BreadcrumbSegment["kind"];
  logo?: string | null;
  dbType?: string | null;
  size?: number;
}) {
  if (kind === "app") {
    return (
      <AppLogo logo={logo ?? null} size={size} className="rounded-[4px]" />
    );
  }
  if (kind === "database") {
    return (
      <DatabaseLogo
        type={(dbType ?? "postgres") as DatabaseType}
        logo={logo ?? null}
        size={size}
        className="rounded-[4px]"
      />
    );
  }
  const Icon =
    kind === "folder"
      ? FolderIcon
      : kind === "project"
        ? Boxes
        : kind === "storage"
          ? DatabaseIcon
          : null;
  return Icon ? (
    <Icon
      className="shrink-0 text-muted-foreground"
      style={{ width: size, height: size }}
    />
  ) : null;
}

function MenuRow({ item }: { item: DropItem }) {
  const icon = (
    <KindIcon kind={item.kind} logo={item.logo} dbType={item.dbType} />
  );
  if (item.current) {
    return (
      <DropdownMenuItem
        disabled
        aria-current="true"
        className="data-[disabled]:opacity-100"
      >
        {icon}
        <span className="truncate">{item.label}</span>
        <span className="sr-only">(current)</span>
        <Check className="ml-auto size-4 text-muted-foreground" />
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem asChild className="cursor-pointer">
      <Link href={item.href}>
        {icon}
        <span className="truncate">{item.label}</span>
      </Link>
    </DropdownMenuItem>
  );
}
