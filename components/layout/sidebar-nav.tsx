"use client";

import * as React from "react";
import Link, { useLinkStatus } from "@/components/ui/link";
import { ChevronRight, Loader2 } from "lucide-react";
import type { NavItem } from "./nav-config/nav-item";
import { useNavSections } from "./use-nav-sections";
import { backOutOf } from "./navigation-history";
import { useRetapRefresh } from "./scroll-to-top";
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
  const {
    pathname,
    menu,
    sections: rendered,
  } = useNavSections(capabilities, isAdmin);
  const deploying = useActiveDeployments();
  const upstream = useUpstreamUpdate();
  const retap = useRetapRefresh();

  function handleNavClick(
    item: NavItem,
    e: React.MouseEvent<HTMLAnchorElement>,
  ) {
    if (retap(e)) return;
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
    [pathname, signature, collapsed],
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
            rendered[i - 1]?.backLink && "pt-0.5",
          )}
        >
          {i > 0 && !rendered[i - 1]?.backLink && (
            <hr className="my-2 border-t border-sidebar-border" />
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
                        "group relative z-10 flex h-10 cursor-default items-center gap-2.5 overflow-hidden rounded-md px-3 text-sm whitespace-nowrap text-muted-foreground/50",
                      )}
                    >
                      {showIcon && <Icon className="size-4 shrink-0" />}
                      <NavLabel hidden={collapsed}>{item.label}</NavLabel>
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
                ? `Deplo ${upstream.next} is available`
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
                      "group relative z-10 flex h-10 cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-3 text-sm whitespace-nowrap transition-colors",
                      active
                        ? "text-foreground"
                        : "text-muted-foreground hover:bg-surface hover:text-foreground focus-visible:bg-surface",
                    )}
                  >
                    {showIcon && <NavIcon item={item} active={active} />}
                    <NavLabel hidden={collapsed}>{item.label}</NavLabel>
                    {!collapsed && item.submenu && <SubmenuChevron />}
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

function NavLabel({
  hidden,
  children,
}: {
  hidden: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn("transition-opacity duration-100", hidden && "opacity-0")}
    >
      {children}
    </span>
  );
}

export function SubmenuChevron() {
  return (
    <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
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
