"use client";

import * as React from "react";
import Link, { useLinkStatus } from "@/components/ui/link";
import { useFlatPathname } from "@/lib/nav";
import { Loader2 } from "lucide-react";
import { sidebarMenuFor } from "./nav-config/active-route";
import { appNav, appSettingsNav } from "./nav-config/app-nav";
import { databaseNav, databaseSettingsNav } from "./nav-config/database-nav";
import { NAV } from "./nav-config/main-nav";
import { canSee, type NavItem, type NavSection } from "./nav-config/nav-item";
import { SETTINGS_NAV } from "./nav-config/settings-nav";
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
  capabilities?: string[];
  isAdmin?: boolean;
}) {
  const pathname = useFlatPathname();
  const caps = new Set(capabilities);
  const service = useAppNav();
  const dbNav = useDbNav();
  const consoleAcknowledged = useConsoleAck() === true;
  const deploying = useActiveDeployments();
  const upstream = useUpstreamUpdate();

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
      if (prefix && backOutOf(prefix) !== "none") e.preventDefault();
    }
    onNavigate?.();
  }

  const { appSlug, dbId, inAppSettings, inDbSettings, inSettings, menu } =
    sidebarMenuFor(pathname);

  const appCaps =
    appSlug && service?.slug === appSlug ? new Set(service.capabilities) : caps;

  let sections: NavSection[];
  if (dbId && inDbSettings) {
    sections = databaseSettingsNav(dbId);
  } else if (dbId) {
    const matches = dbNav?.id === dbId;
    sections = databaseNav(dbId, {
      pathname,
      consoleAcknowledged,
      cronsEnabled: matches ? dbNav!.cronsEnabled : false,
      logo: matches ? dbNav!.logo : undefined,
      type: matches ? dbNav!.type : undefined,
    });
  } else if (appSlug && inAppSettings) {
    sections = appSettingsNav(
      appSlug,
      service?.slug === appSlug ? service.isGithubApp : true,
    );
  } else if (appSlug) {
    const matches = service?.slug === appSlug;
    sections = appNav(appSlug, {
      pathname,
      canManageEnv: appCaps.has("manage_env"),
      canBackup: appCaps.has("manage_backups"),
      running: matches ? service!.running : false,
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

  const rendered = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        canSee(item, appSlug ? appCaps : caps, isAdmin),
      ),
    }))
    .filter((section) => section.items.length > 0);

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
      className={cn("relative isolate flex flex-col px-2 pt-1 pb-3", slide)}
    >
      <SlidingBackground rect={bgRect} />
      {rendered.map((section, i) => (
        <div
          key={i}
          className={cn(
            "flex flex-col gap-0.5",
            i > 0 && !section.title && !collapsed && "pt-0.5",
          )}
        >
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
            i > 0 &&
            collapsed && (
              <hr className="mx-1 my-2 border-t border-sidebar-border" />
            )
          )}
          {section.items.map((item) => {
            const active = isActive(item.href, item.exact);
            const Icon = item.icon;
            const showIcon = !section.iconless || collapsed;
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
                      {showIcon && <Icon className="size-4 shrink-0" />}
                      {!collapsed && item.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {item.disabledReason}
                  </TooltipContent>
                </Tooltip>
              );
            }
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
                      "group relative z-10 flex cursor-pointer items-center gap-2.5 rounded-md text-sm transition-colors",
                      collapsed ? "h-9 w-9 justify-center" : "px-3 py-2",
                      active
                        ? "text-foreground"
                        : "text-muted-foreground hover:bg-surface hover:text-foreground focus-visible:bg-surface",
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

const SPINNER_DELAY_MS = 150;
const SPINNER_HOLD_MS = 300;

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

function NavIcon({ item, active }: { item: NavItem; active: boolean }) {
  const spinning = useSlowPending();
  const Icon = item.icon;
  if (spinning) return <NavSpinner />;
  if (item.mark) return <NavMark mark={item.mark} />;
  return (
    <Icon
      className={cn(
        "size-4 shrink-0",
        active
          ? "text-foreground"
          : "text-muted-foreground group-hover:text-foreground",
      )}
    />
  );
}

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
