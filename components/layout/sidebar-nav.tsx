"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  NAV,
  SETTINGS_NAV,
  appNav,
  appSettingsNav,
  type NavItem,
  type NavSection,
} from "./nav-config";
import { backOutOf } from "./navigation-history";
import { useAppNav } from "@/components/apps/app-nav-store";
import { useConsoleAck } from "@/components/apps/console-ack";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useSlidingRect,
  SlidingBackground,
} from "@/components/ui/sliding-underline";

export function SidebarNav({
  onNavigate,
  collapsed = false,
  capabilities = [],
  isAdmin = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
  /** The current member's capabilities; items whose `requires` isn't held are hidden. */
  capabilities?: string[];
  /** Instance admin — gates items marked `requiresAdmin` (e.g. the Users settings). */
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const caps = new Set(capabilities);
  const service = useAppNav();
  // The console chip is unlocked only once the user confirms its warning; `null`
  // (undecided, pre-hydration) reads as "not yet" so nothing flashes.
  const consoleAcknowledged = useConsoleAck() === true;

  // A "back" escape hatch leaves the whole current section via the browser's
  // history — jumping to the last page you were on *outside* it — so it lands
  // where you came from instead of stepping between sibling pages. Its href
  // (Back to apps / dashboard) is the fallback when there's no such page
  // (a fresh load, a reload). Modified clicks (⌘/ctrl/shift/alt → new tab) fall
  // through to the href untouched.
  function handleNavClick(item: NavItem, e: React.MouseEvent<HTMLAnchorElement>) {
    if (
      item.back &&
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      const slug = pathname.match(/^\/apps\/([^/]+)/)?.[1];
      const prefix = slug
        ? `/apps/${slug}`
        : pathname.startsWith("/settings")
          ? "/settings"
          : null;
      // Suppress the href when we handled it (jumped out, or a jump is already
      // running); only "none" — no in-app page outside the section — follows it.
      if (prefix && backOutOf(prefix) !== "none") e.preventDefault();
    }
    onNavigate?.();
  }

  // The same sidebar shows one of four navigations depending on where you are:
  // inside an app it becomes that app's sub-menu; one level deeper, under
  // that app's /settings, its settings sub-menu; under the top-level /settings
  // the settings sub-menu; otherwise the main dashboard nav. One sidebar system,
  // four left-hand navigations.
  const appSlug = pathname.match(/^\/apps\/([^/]+)/)?.[1] ?? null;
  // An app's own settings live one level deeper than its main nav, so the
  // sidebar swaps again once you're under /apps/<slug>/settings.
  const inAppSettings =
    appSlug != null && /^\/apps\/[^/]+\/settings(?:\/|$)/.test(pathname);
  const inSettings = pathname.startsWith("/settings");
  const menu: "service-settings" | "service" | "settings" | "main" = appSlug
    ? inAppSettings
      ? "service-settings"
      : "service"
    : inSettings
      ? "settings"
      : "main";

  let sections: NavSection[];
  if (appSlug && inAppSettings) {
    sections = appSettingsNav(appSlug);
  } else if (appSlug) {
    // Capability-gated entries come from the sidebar's own capability list; the
    // live/per-app flags come from the store — but only when it matches the
    // slug in the URL, so a stale value from the app you just left can't
    // leak its Console/Logs/Dev/Files into the next one.
    const matches = service?.slug === appSlug;
    sections = appNav(appSlug, {
      pathname,
      canManageEnv: caps.has("manage_env"),
      canBackup: caps.has("manage_infra"),
      running: matches ? service!.running : false,
      devEligible: matches ? service!.devEligible : false,
      showFiles: matches ? service!.showFiles : false,
      consoleAcknowledged,
    });
  } else if (inSettings) {
    sections = SETTINGS_NAV;
  } else {
    sections = NAV;
  }

  // Filter by capability/admin up front so the sliding-pill signature and the
  // render use the exact same item set (app entries are pre-filtered by the
  // builder, so this is a no-op for them).
  const rendered = sections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          (!item.requires || caps.has(item.requires)) &&
          (!item.requiresAdmin || isAdmin),
      ),
    }))
    .filter((section) => section.items.length > 0);

  // Slide the nav horizontally when it swaps between navigations: in from the
  // right going deeper (main → service → service-settings, or main → settings),
  // from the left coming back up. Each navigation has a depth; the slide plays
  // toward the deeper one. Comparing against the previous render's value (a
  // supported React pattern) plays the slide only on the boundary crossing — not
  // on the initial mount or same-menu navigations.
  const DEPTH: Record<typeof menu, number> = {
    main: 0,
    settings: 1,
    service: 1,
    "service-settings": 2,
  };
  const [prevMenu, setPrevMenu] = React.useState(menu);
  const [slide, setSlide] = React.useState("");
  if (prevMenu !== menu) {
    setPrevMenu(menu);
    setSlide(
      DEPTH[menu] >= DEPTH[prevMenu]
        ? "animate-slide-in-right"
        : "animate-slide-in-left",
    );
  }

  // Single background "pill" that slides to the active item — only its
  // background moves between entries. Re-measured on navigation and whenever the
  // rendered item set changes (an app's Console/Logs entries appear and
  // disappear as its container starts/stops).
  const navRef = React.useRef<HTMLElement | null>(null);
  const signature = rendered
    .map((s) => s.items.map((i) => i.href).join(","))
    .join("|");
  const bgRect = useSlidingRect(
    navRef,
    () =>
      navRef.current?.querySelector<HTMLElement>('[data-active="true"]') ?? null,
    [pathname, signature],
  );

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <nav
      ref={navRef}
      className={cn(
        "relative isolate flex flex-col py-3",
        collapsed ? "px-2" : "px-3",
        slide,
      )}
    >
      <SlidingBackground rect={bgRect} />
      {rendered.map((section, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          {/* A titled group shows its label as a header; an untitled one falls
              back to a Vercel-style divider. Collapsed (icon-only) always uses a
              divider since there's no room for the label. */}
          {section.title && !collapsed ? (
            <div
              className={cn(
                "px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70",
                i > 0 && "pt-3",
              )}
            >
              {section.title}
            </div>
          ) : (
            i > 0 && (
              <hr
                className={cn(
                  "my-2 border-t border-sidebar-border",
                  collapsed ? "mx-1" : "mx-2",
                )}
              />
            )
          )}
          {section.items.map((item) => {
            const active = isActive(item.href, item.exact);
            const Icon = item.icon;
            return (
              <Tooltip key={item.href} delayDuration={collapsed ? 0 : 400}>
                <TooltipTrigger asChild>
                  <Link
                    href={item.href}
                    onClick={(e) => handleNavClick(item, e)}
                    aria-label={item.label}
                    data-active={active ? "true" : undefined}
                    className={cn(
                      // relative z-10 keeps the label/icon above the sliding pill.
                      "group relative z-10 flex cursor-pointer items-center gap-2.5 rounded-md text-sm transition-colors",
                      collapsed ? "h-9 w-9 justify-center" : "px-3 py-1.5",
                      active
                        ? "text-foreground"
                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:bg-foreground/5",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        active
                          ? "text-foreground"
                          : "text-muted-foreground group-hover:text-foreground",
                      )}
                    />
                    {!collapsed && item.label}
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {collapsed ? item.label : item.tooltip}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
