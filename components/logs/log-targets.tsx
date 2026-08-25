"use client";

import * as React from "react";
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

/** A row of the picker: a line of the tree, or an action parked at its end. */
type PickerItem =
  | { kind: "row"; row: LogTreeRow }
  | { kind: "action"; key: string; label: string; icon: React.ReactNode };

type PickerAction = Extract<PickerItem, { kind: "action" }>;

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
  actions = [],
  autoFocus = false,
  className,
}: {
  rows: LogTreeRow[];
  /** The key of the target on screen, or "" while nothing is picked. */
  value: string;
  onChange: (key: string) => void;
  /** Parked at the END of the list and matching only the empty query, so they
   *  are one keystroke from gone and never come between somebody and the app
   *  they are typing. */
  actions?: PickerAction[];
  autoFocus?: boolean;
  className?: string;
}) {
  const items: PickerItem[] = [
    ...rows.map((row) => ({ kind: "row" as const, row })),
    ...actions,
  ];

  return (
    <div className={className}>
      <Combobox<PickerItem>
        items={items}
        value={value}
        onChange={onChange}
        autoFocus={autoFocus}
        getKey={(i) => (i.kind === "row" ? i.row.key : i.key)}
        selectable={(i) => (i.kind === "row" ? !!i.row.target : true)}
        matches={(i, q) =>
          i.kind === "row" ? logTreeMatches(i.row, q) : q.length === 0
        }
        displayValue={(i) => (i.kind === "row" ? i.row.name : i.label)}
        renderLeading={(i) =>
          i.kind === "row" && i.row.target ? (
            <TargetMark target={i.row.target} size={20} />
          ) : null
        }
        renderOption={(i) =>
          i.kind === "row" ? (
            <TreeRowContent row={i.row} />
          ) : (
            <span className="flex items-center gap-2 border-t border-border pt-2 text-sm text-muted-foreground">
              {i.icon}
              {i.label}
            </span>
          )
        }
        placeholder="Search apps and databases"
        searchPlaceholder="Search apps and databases"
        emptyLabel={() => "No app or database goes by that name"}
      />
    </div>
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
 * chevron), so drawing both would say it twice; the way back moves into the
 * menu instead, at the END of the list where it matches only the empty query.
 *
 * The menu's own footer slot is NOT used for it: it renders outside the field,
 * so anything hung there dangles under the toolbar row forever.
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
  const current = rows.find((r) => r.key === value)?.target ?? null;

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

  const actions: PickerAction[] = current
    ? [
        {
          kind: "action",
          key: "action:open",
          label: `Open ${current.name}`,
          icon: <ExternalLink className="size-4 text-muted-foreground" />,
        },
      ]
    : [];

  function go(key: string) {
    if (key === "action:open" && current)
      return router.push(logTargetOverviewHref(current.key));
    if (key !== value) router.push(logTargetHref(key));
  }

  return (
    <LogTreePicker
      rows={rows}
      value={value}
      onChange={go}
      actions={actions}
      className="w-64 shrink-0"
    />
  );
}
