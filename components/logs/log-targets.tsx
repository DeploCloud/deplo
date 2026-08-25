"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Boxes,
  Database,
  ExternalLink,
  Folder,
  FolderTree,
} from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { StatusDot } from "@/components/shared/status-badge";
import { LogsGraphic } from "@/components/apps/logs-graphic";
import { Combobox } from "@/components/shared/combobox";
import { TintedMark } from "@/components/shared/tinted-mark";
import {
  LOG_TARGET_COOKIE,
  logTargetHref,
  logTargetOverviewHref,
  logTreeMatches,
  type LogTarget,
  type LogTreeRow,
} from "@/components/logs/log-target";

/** The mark for a target: an App's own logo, or a database's engine brand when
 *  it has none of its own. */
function TargetMark({ target, size }: { target: LogTarget; size: number }) {
  return target.kind === "database" ? (
    <DatabaseLogo
      type={target.type ?? "postgres"}
      logo={target.logo}
      size={size}
    />
  ) : (
    <AppLogo logo={target.logo} size={size} />
  );
}

/** How much one level of the tree steps in, in px. Inline, because Tailwind has
 *  no dynamic `pl-`. */
const INDENT = 14;

const HEADING_ICON = {
  project: FolderTree,
  environment: Boxes,
  folder: Folder,
  section: Database,
} as const;

function TreeRowContent({ row }: { row: LogTreeRow }) {
  if (row.target) {
    // The option button already pads the row; this only adds the depth.
    return (
      <span
        className="flex items-center gap-2"
        style={{ paddingLeft: row.depth * INDENT }}
      >
        <TargetMark target={row.target} size={20} />
        <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
        <StatusDot status={row.target.status} />
      </span>
    );
  }
  // A heading is not a button, so it carries the row padding itself.
  const Icon = HEADING_ICON[row.kind as keyof typeof HEADING_ICON] ?? Folder;
  const tinted = row.kind === "project" || row.kind === "folder";
  return (
    <span
      className="flex items-center gap-2 py-1.5 pr-2 text-xs font-medium text-muted-foreground"
      style={{ paddingLeft: 8 + row.depth * INDENT }}
    >
      {tinted ? (
        <TintedMark icon={Icon} color={row.color ?? null} />
      ) : (
        <Icon className="size-3.5" />
      )}
      <span className="truncate">{row.name}</span>
    </span>
  );
}

/**
 * Which logs to look at, as the tree they actually live in: projects and their
 * environments, folders as deep as they nest, then the apps at the top level and
 * the databases.
 *
 * One control, drawn twice — in the middle of the chooser, and in the pane's
 * toolbar where it stands in for the title. The same shape both times on
 * purpose: picking a target is one decision, and a decision with two grammars
 * costs the reader a pause every time they meet the second one.
 *
 * Headings are drawn but never landed on (`selectable`), and typing filters on
 * {@link LogTreeRow.haystack}, which is what keeps an app's headings on screen
 * while narrowing to it.
 */
export function LogTreePicker({
  rows,
  value,
  onChange,
  autoFocus = false,
  className,
}: {
  rows: LogTreeRow[];
  /** The key of the target on screen, or "" while nothing is picked. */
  value: string;
  onChange: (key: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <Combobox<LogTreeRow>
        items={rows}
        value={value}
        onChange={onChange}
        autoFocus={autoFocus}
        getKey={(r) => r.key}
        selectable={(r) => !!r.target}
        matches={logTreeMatches}
        displayValue={(r) => r.name}
        renderLeading={(r) =>
          r.target ? <TargetMark target={r.target} size={20} /> : null
        }
        renderOption={(r) => <TreeRowContent row={r} />}
        renderTrailing={(r) =>
          r.key === value && value ? <OpenTargetLink row={r} /> : null
        }
        placeholder="Search apps and databases"
        searchPlaceholder="Search apps and databases"
        emptyLabel={() => "No app or database goes by that name"}
      />
    </div>
  );
}

/**
 * The way back to the thing itself, on the row of the thing you are already
 * watching.
 *
 * It used to be an "Open <name>" row at the end of the list, which read as one
 * more app to pick — a menu footer wearing an app's clothes. As an icon at the
 * end of the active row it is where the eye already is, and it says what it
 * does: a new tab, so the logs you are watching stay where they are.
 */
function OpenTargetLink({ row }: { row: LogTreeRow }) {
  const label = `Open ${row.name} in a new tab`;
  return (
    <Link
      href={logTargetOverviewHref(row.key)}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      // The native tooltip, not `SimpleTooltip`: the menu is `z-[60]` and the
      // tooltip is `z-50`, so a real one renders BEHIND the list it belongs to.
      title={label}
      // The row underneath picks on mousedown; without this the click would
      // land on a menu that has already closed and swapped the page.
      onMouseDown={(e) => e.stopPropagation()}
      className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <ExternalLink className="size-3.5" />
    </Link>
  );
}

/**
 * Step one of the Logs page: which thing's logs are we here for.
 *
 * One question in the middle of the screen, answered by typing — not a wall of
 * cards to read through. It replaced a grid because a picker is not a
 * destination: nobody comes to `/logs` to browse a list of their apps, they come
 * to read one app's output, and three letters beats a scan every time.
 */
export function LogChooser({ rows }: { rows: LogTreeRow[] }) {
  const router = useRouter();
  const hasTargets = rows.some((r) => r.target);

  // The route is full-bleed, so the frame has no padding: this screen owns both
  // its padding and its own centring. The extra padding at the BOTTOM lifts the
  // block a little above true centre — optically centred, and it leaves the
  // dropdown enough room to open downwards instead of flipping up over the
  // question it is answering.
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6 pb-24">
      {hasTargets ? (
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center text-center">
            <LogsGraphic />
            <h1 className="mt-5 text-xl font-semibold tracking-tight">
              Which logs do you want to see?
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick an app or a database to watch its output live.
            </p>
          </div>
          <LogTreePicker
            rows={rows}
            value=""
            onChange={(key) => router.push(logTargetHref(key))}
            autoFocus
            className="mt-6"
          />
        </div>
      ) : (
        <EmptyState
          graphic={<LogsGraphic />}
          title="No logs to read yet"
          description="Deploy an app or create a database, and its logs show up here."
        />
      )}
    </div>
  );
}

/**
 * The toolbar's first cell on the general Logs page: the target picker, which
 * IS the title.
 *
 * The pane's usual heading is `PaneTitleLink` — the name, and the way back to
 * the thing. Here the name is said by the picker's own field (logo, name,
 * chevron), so drawing both would say it twice; the way back is the icon on the
 * open target's own row inside the menu (see {@link OpenTargetLink}).
 */
export function LogTargetPicker({
  rows,
  value,
}: {
  rows: LogTreeRow[];
  /** The key of the target on screen. Confirmed by the server, which is why
   *  this and not the URL is what gets remembered. */
  value: string;
}) {
  const router = useRouter();

  // Remember the target so the sidebar's Logs entry reopens it. Written here,
  // after the server resolved it, so a stale or forbidden one is never stored;
  // read back in the page, which validates it against this same list. Client-
  // side because a GET cannot set a cookie from an RSC render, and localStorage
  // cannot be read there at all — which is what would make the chooser flash.
  React.useEffect(() => {
    if (!value) return;
    try {
      document.cookie = `${LOG_TARGET_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* storage blocked → nothing to remember, and nothing to break */
    }
  }, [value]);

  return (
    <LogTreePicker
      rows={rows}
      value={value}
      onChange={(key) => {
        if (key !== value) router.push(logTargetHref(key));
      }}
      className="w-64 shrink-0"
    />
  );
}
