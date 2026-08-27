"use client";

import * as React from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  NAV,
  SETTINGS_NAV,
  appNav,
  appSettingsNav,
  isGearIcon,
  sidebarMenuFor,
  databaseNav,
  databaseSettingsNav,
  type NavItem,
  type NavSection,
} from "./nav-config";
import { backOutOf } from "./navigation-history";
import { useAppNav } from "@/components/apps/app-nav-store";
import { useDbNav } from "@/components/storage/db-nav-store";
import { useConsoleAck } from "@/components/apps/console-ack";
import { useActiveDeployments } from "./deploy-activity";
import { useUpstreamUpdate } from "./update-state";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/shared/status-badge";
import { AppLogo } from "@/components/shared/project-logo";
import { DatabaseLogo } from "@/components/storage/database-logo";
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
  /** Instance admin - gates items marked `requiresAdmin` (e.g. the Users settings). */
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const caps = new Set(capabilities);
  const service = useAppNav();
  const dbNav = useDbNav();
  // A DATABASE console is still unlocked by the one-time "I understand"; an app's
  // is a per-app switch instead. `null` (pre-hydration) reads as "not yet".
  const consoleAcknowledged = useConsoleAck() === true;
  // Builds in flight right now, live. Decorates the Deployments entry so a
  // running deploy is visible from anywhere in the dashboard.
  const deploying = useActiveDeployments();
  // A newer Deplo upstream, so the entry that owns the instance says so from
  // anywhere in Settings. Independent of the banner's dismissal.
  const upstream = useUpstreamUpdate();

  // A "back" escape hatch leaves the whole current section via the browser's history,
  // jumping to the last page you were on *outside* it, so it lands where you came
  // from instead of stepping between sibling pages.
  function handleNavClick(
    item: NavItem,
    e: React.MouseEvent<HTMLAnchorElement>,
  ) {
    if (
      item.back &&
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      const slug = pathname.match(/^\/apps\/([^/]+)/)?.[1];
      const dbId = pathname.match(/^\/storage\/databases\/([^/]+)/)?.[1];
      const prefix = slug
        ? `/apps/${slug}`
        : dbId
          ? `/storage/databases/${dbId}`
          : pathname.startsWith("/settings")
            ? "/settings"
            : null;
      // Suppress the href when we handled it (jumped out, or a jump is already
      // running); only "none", no in-app page outside the section, follows it.
      if (prefix && backOutOf(prefix) !== "none") e.preventDefault();
    }
    onNavigate?.();
  }

  // The same sidebar shows one of four navigations depending on where you are: inside
  // an app it becomes that app's sub-menu; one level deeper, under that app's
  // /settings, its settings sub-menu; under the top-level /settings the settings
  const { appSlug, dbId, inAppSettings, inDbSettings, inSettings, menu } =
    sidebarMenuFor(pathname);

  // Inside an app, the gate is what the viewer holds on THAT app (published by the
  // app layout), not the team-wide union this sidebar is handed - that union is
  // deliberately wider than the truth so a per-folder grant doesn't hide the nav, and
  const appCaps =
    appSlug && service?.slug === appSlug ? new Set(service.capabilities) : caps;

  let sections: NavSection[];
  if (dbId && inDbSettings) {
    sections = databaseSettingsNav(dbId);
  } else if (dbId) {
    // Only trusted while the store matches the id in the URL, so a stale flag
    // from the database you just left cannot leak into the next one.
    const matches = dbNav?.id === dbId;
    sections = databaseNav(dbId, {
      pathname,
      consoleAcknowledged,
      cronsEnabled: matches ? dbNav!.cronsEnabled : false,
      // Left undefined until it matches: the generic glyph stands in rather
      // than the last database's brand mark.
      logo: matches ? dbNav!.logo : undefined,
      type: matches ? dbNav!.type : undefined,
    });
  } else if (appSlug && inAppSettings) {
    // Until the store matches the slug in the URL (SSR, first paint) assume the app IS
    // a GitHub one: that renders the entry live rather than disabled, and a link that
    // becomes disabled a moment later is a smaller lie than a "cannot be enabled" that
    sections = appSettingsNav(
      appSlug,
      service?.slug === appSlug ? service.isGithubApp : true,
    );
  } else if (appSlug) {
    // The live/per-app flags come from the same store as the capabilities above.
    const matches = service?.slug === appSlug;
    sections = appNav(appSlug, {
      pathname,
      canManageEnv: appCaps.has("manage_env"),
      canBackup: appCaps.has("manage_backups"),
      running: matches ? service!.running : false,
      showFiles: matches ? service!.showFiles : false,
      isGithubApp: matches ? service!.isGithubApp : false,
      previewsEnabled: matches ? service!.previewsEnabled : false,
      cronsEnabled: matches ? service!.cronsEnabled : false,
      logo: matches ? service!.logo : undefined,
      consoleEnabled: matches ? service!.consoleEnabled : false,
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
          (!item.requires || (appSlug ? appCaps : caps).has(item.requires)) &&
          (!item.requiresAny ||
            item.requiresAny.some((c) => (appSlug ? appCaps : caps).has(c))) &&
          (!item.requiresAdmin || isAdmin),
      ),
    }))
    .filter((section) => section.items.length > 0);

  // Slide the nav horizontally when it swaps between navigations: in from the right
  // going deeper (main → service → service-settings, or main → settings), from the
  // left coming back up.
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

  // Single background "pill" that slides to the active item - only its background
  // moves between entries.
  const navRef = React.useRef<HTMLElement | null>(null);
  const signature = rendered
    .map((s) => s.items.map((i) => i.href).join(","))
    .join("|");
  const bgRect = useSlidingRect(
    navRef,
    () =>
      navRef.current?.querySelector<HTMLElement>('[data-active="true"]') ??
      null,
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
        // No top padding: the search box above already leaves its own gap, and a
        // second one made the first row float away from it.
        "relative isolate flex flex-col pb-3",
        collapsed ? "px-2" : "px-3",
        slide,
      )}
    >
      <SlidingBackground rect={bgRect} />
      {rendered.map((section, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          {/* A titled group shows its label as a header; an untitled one falls
              back to a divider, as does the collapsed rail - no room for a label. */}
          {section.title && !collapsed ? (
            <div
              className={cn(
                "px-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase",
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
            // A text-only section (app/database settings) drops the icons, but
            // never while collapsed, where the icon is the only thing rendered.
            const showIcon = !section.iconless || collapsed;
            // A settings entry the app CANNOT use - pull request previews on an app that
            // deploys from anything but GitHub.
            if (item.disabledReason) {
              return (
                <Tooltip key={item.href} delayDuration={collapsed ? 0 : 400}>
                  <TooltipTrigger asChild>
                    <span
                      aria-disabled="true"
                      aria-label={item.label}
                      className={cn(
                        "group relative z-10 flex cursor-default items-center gap-2.5 rounded-md text-sm text-muted-foreground/50",
                        collapsed ? "h-9 w-9 justify-center" : "px-3 py-2",
                      )}
                    >
                      {showIcon && (
                        <Icon
                          className={cn(
                            "size-4 shrink-0",
                            isGearIcon(item.icon) && "deplo-gear",
                          )}
                        />
                      )}
                      {!collapsed && item.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {item.disabledReason}
                  </TooltipContent>
                </Tooltip>
              );
            }
            // "3 deployments in progress" replaces both the label and the
            // tooltip while builds are running: with the chip on, that IS what
            // the entry is saying.
            const deployingTip =
              item.href === "/deployments" && deploying > 0
                ? `${deploying} deployment${deploying === 1 ? "" : "s"} in progress`
                : null;
            const updateTip =
              upstream && item.href === "/settings/deplo"
                ? `Deplo ${upstream.latest} is available`
                : null;
            return (
              <Tooltip key={item.href} delayDuration={collapsed ? 0 : 400}>
                <TooltipTrigger asChild>
                  <Link
                    href={item.href}
                    onClick={(e) => handleNavClick(item, e)}
                    aria-label={
                      deployingTip
                        ? `${item.label}, ${deployingTip}`
                        : item.label
                    }
                    data-active={active ? "true" : undefined}
                    className={cn(
                      // relative z-10 keeps the label/icon above the sliding pill.
                      "group relative z-10 flex cursor-pointer items-center gap-2.5 rounded-md text-sm transition-colors",
                      collapsed ? "h-9 w-9 justify-center" : "px-3 py-2",
                      active
                        ? "text-foreground"
                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:bg-foreground/5",
                    )}
                  >
                    {showIcon && <NavIcon item={item} active={active} />}
                    {!collapsed && item.label}
                    {!showIcon && <NavPending />}
                    {updateTip &&
                      (collapsed ? (
                        <span className="absolute top-1 right-1 size-2 rounded-full bg-[var(--success)]" />
                      ) : (
                        <span className="ml-auto size-2 shrink-0 rounded-full bg-[var(--success)]" />
                      ))}
                    {deployingTip &&
                      (collapsed ? (
                        // No room for a number next to the icon: the pulsing dot
                        // alone, in its corner, like any unread marker.
                        <StatusDot
                          status="building"
                          className="absolute top-1 right-1"
                        />
                      ) : (
                        <Badge
                          variant="warning"
                          className="ml-auto gap-1.5 px-1.5 py-0 tabular-nums"
                        >
                          <StatusDot status="building" />
                          {deploying}
                        </Badge>
                      ))}
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {deployingTip ??
                    (collapsed ? item.label : (updateTip ?? item.tooltip))}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

// Wait this long before a spinner replaces the icon, then keep it up at least this
// long: under the first a fast page never flashes it, under the second a click that
// resolves right after would blink it straight back out.
const SPINNER_DELAY_MS = 150;
const SPINNER_HOLD_MS = 300;

/**
 * Pending, once it has lasted long enough to be worth saying - and then for long
 * enough to be seen. The icon stays put in between, so nothing blanks out.
 */
function useSlowPending(): boolean {
  const { pending } = useLinkStatus();
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(
      () => setShown(pending),
      pending ? SPINNER_DELAY_MS : SPINNER_HOLD_MS,
    );
    return () => clearTimeout(t);
  }, [pending]);
  return shown;
}

/**
 * The entry's icon, replaced by a spinner while its page loads. Most routes carry
 * no `loading.tsx` (they render in a few ms), so this is the click's only feedback.
 */
function NavIcon({ item, active }: { item: NavItem; active: boolean }) {
  const spinning = useSlowPending();
  const Icon = item.icon;
  if (spinning) return <NavSpinner />;
  if (item.mark) return <NavMark mark={item.mark} />;
  return (
    <Icon
      className={cn(
        "size-4 shrink-0",
        isGearIcon(item.icon) && "deplo-gear",
        active
          ? "text-foreground"
          : "text-muted-foreground group-hover:text-foreground",
      )}
    />
  );
}

/** The same pending state for a text-only section, which has no icon to swap. */
function NavPending() {
  return useSlowPending() ? <NavSpinner className="ml-auto" /> : null;
}

function NavSpinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 animate-in items-center justify-center fade-in",
        className,
      )}
    >
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    </span>
  );
}

/**
 * The picture on an app's or database's Overview entry, in the place the icon
 * would take.
 */
function NavMark({ mark }: { mark: NonNullable<NavItem["mark"]> }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {mark.kind === "database" ? (
        <DatabaseLogo type={mark.type} logo={mark.logo} size={16} />
      ) : (
        <AppLogo logo={mark.logo} size={16} />
      )}
    </span>
  );
}
