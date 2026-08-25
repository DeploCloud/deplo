"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, LayoutGrid, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { StatusDot } from "@/components/shared/status-badge";
import { LogsGraphic } from "@/components/apps/logs-graphic";
import { Combobox } from "@/components/shared/combobox";
import {
  LOG_CHOOSER_HREF,
  LOG_TARGET_COOKIE,
  logTargetHref,
  logTargetMatches,
  logTargetOverviewHref,
  type LogTarget,
} from "@/components/logs/log-target";

/** The mark for a target, in both the grid and the picker: an App's own logo,
 *  or a database's engine brand when it has none of its own. */
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

/**
 * Step one of the Logs page: which thing's logs are we here for.
 *
 * A flat, searchable grid rather than the project/folder tree, because this is
 * a "get me to the logs" screen and typing three letters beats walking a
 * hierarchy. Cards are plain links, so the whole screen works before any
 * JavaScript settles, and deliberately NOT `AppCard` — that one opens a live
 * GraphQL subscription per card, which for a picker is forty subscriptions to
 * paint a list nobody stays on.
 */
export function LogChooser({ targets }: { targets: LogTarget[] }) {
  const [query, setQuery] = React.useState("");
  const shown = targets.filter((t) => logTargetMatches(t, query));
  const apps = shown.filter((t) => t.kind === "app");
  const databases = shown.filter((t) => t.kind === "database");

  // The route is full-bleed, so the frame has no padding and does not scroll:
  // this screen owns both, or a long list is simply unreachable.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">
          Which logs do you want to see?
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick an app or a database to watch its output.
        </p>

        {targets.length > 0 && (
          <div className="relative mt-6">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search apps and databases"
              aria-label="Search apps and databases"
              autoFocus
              className="pl-9"
            />
          </div>
        )}

        {targets.length === 0 ? (
          <div className="mt-10">
            <EmptyState
              graphic={<LogsGraphic />}
              title="No logs to read yet"
              description="Deploy an app or create a database, and its logs show up here."
            />
          </div>
        ) : shown.length === 0 ? (
          <div className="mt-10">
            <EmptyState
              icon={Search}
              title="Nothing matches"
              description="No app or database goes by that name."
            />
          </div>
        ) : (
          <div className="mt-8 space-y-8">
            <TargetSection title="Apps" targets={apps} />
            <TargetSection title="Databases" targets={databases} />
          </div>
        )}
      </div>
    </div>
  );
}

function TargetSection({
  title,
  targets,
}: {
  title: string;
  targets: LogTarget[];
}) {
  if (targets.length === 0) return null;
  return (
    <section>
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {targets.map((t) => (
          <Link
            key={t.key}
            href={logTargetHref(t.key)}
            className="flex items-center gap-3 rounded-xl border border-border bg-card/40 px-3 py-3 transition-colors hover:border-ring hover:bg-accent/40"
          >
            <TargetMark target={t} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{t.name}</div>
              <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {t.detail}
              </div>
            </div>
            <StatusDot status={t.status} />
          </Link>
        ))}
      </div>
    </section>
  );
}

/** A row of the picker: either a target to jump to, or one of the two actions
 *  parked at the end of the list. */
type PickerItem =
  | { kind: "target"; target: LogTarget }
  | { kind: "action"; key: string; label: string; icon: React.ReactNode };

/**
 * The toolbar's first cell on the general Logs page: the target picker, which
 * IS the title.
 *
 * The pane's usual heading is `PaneTitleLink` — the name, and the way back to
 * the thing. Here the name is said by the picker's own field (logo, name,
 * chevron), so drawing both would say it twice; the way back moves into the
 * menu instead, alongside the way back to the chooser. Both actions sit at the
 * END of the list and match only the empty query, so they are one keystroke
 * from gone and never come between somebody and the app they are typing.
 *
 * The menu's own footer slot is NOT used for them: it renders outside the
 * field, so anything hung there dangles under the toolbar row forever.
 */
export function LogTargetPicker({
  targets,
  value,
}: {
  targets: LogTarget[];
  /** The key of the target on screen. Confirmed by the server, which is why
   *  this and not the URL is what gets remembered. */
  value: string;
}) {
  const router = useRouter();
  const current = targets.find((t) => t.key === value) ?? null;

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

  const items: PickerItem[] = [
    ...targets.map((target) => ({ kind: "target" as const, target })),
    ...(current
      ? [
          {
            kind: "action" as const,
            key: "action:open",
            label: `Open ${current.name}`,
            icon: <ExternalLink className="size-4 text-muted-foreground" />,
          },
        ]
      : []),
    {
      kind: "action" as const,
      key: "action:browse",
      label: "Browse all logs",
      icon: <LayoutGrid className="size-4 text-muted-foreground" />,
    },
  ];

  function go(key: string) {
    if (key === "action:browse") return router.push(LOG_CHOOSER_HREF);
    if (key === "action:open" && current)
      return router.push(logTargetOverviewHref(current.key));
    if (key !== value) router.push(logTargetHref(key));
  }

  return (
    <div className="w-44 shrink-0">
      <Combobox<PickerItem>
        items={items}
        value={value}
        onChange={go}
        getKey={(i) => (i.kind === "target" ? i.target.key : i.key)}
        // An action survives only the empty query: they are a menu footer in
        // list clothing, not something to sift through while typing a name.
        matches={(i, q) =>
          i.kind === "target" ? logTargetMatches(i.target, q) : q.length === 0
        }
        displayValue={(i) => (i.kind === "target" ? i.target.name : i.label)}
        renderLeading={(i) =>
          i.kind === "target" ? (
            <TargetMark target={i.target} size={20} />
          ) : null
        }
        renderOption={(i) =>
          i.kind === "target" ? (
            <span className="flex items-center gap-2">
              <TargetMark target={i.target} size={20} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{i.target.name}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {i.target.detail}
                </span>
              </span>
              <StatusDot status={i.target.status} />
            </span>
          ) : (
            <span className="flex items-center gap-2 border-t border-border pt-2 text-sm text-muted-foreground">
              {i.icon}
              {i.label}
            </span>
          )
        }
        placeholder="Pick an app or database"
        searchPlaceholder="Search apps and databases"
        emptyLabel={() => "No app or database goes by that name"}
      />
    </div>
  );
}
