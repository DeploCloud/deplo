"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, SETTINGS_NAV } from "./nav-config";
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

  // Inside settings, the same sidebar shows the settings nav instead of the
  // main nav — one sidebar system, a different left-hand navigation.
  const inSettings = pathname.startsWith("/settings");
  const sections = inSettings ? SETTINGS_NAV : NAV;

  // Slide the nav horizontally when it swaps between the main nav and a sub-menu
  // (e.g. Settings): in from the right going deeper, from the left coming back.
  // Comparing against the previous render's value (a supported React pattern)
  // applies the slide class only on the boundary crossing — so it plays on the
  // transition, but not on the initial mount or same-menu navigations.
  const [prevInSettings, setPrevInSettings] = React.useState(inSettings);
  const [slide, setSlide] = React.useState("");
  if (prevInSettings !== inSettings) {
    setPrevInSettings(inSettings);
    setSlide(inSettings ? "animate-slide-in-right" : "animate-slide-in-left");
  }

  // Single background "pill" that slides to the active item — only its
  // background moves between entries (the font weight stays constant). Measured
  // on navigation; the ResizeObserver also catches sidebar width changes.
  const navRef = React.useRef<HTMLElement | null>(null);
  const bgRect = useSlidingRect(
    navRef,
    () => navRef.current?.querySelector<HTMLElement>('[data-active="true"]') ?? null,
    [pathname],
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
      {sections.map((section, i) => {
        const items = section.items.filter(
          (item) =>
            (!item.requires || caps.has(item.requires)) &&
            (!item.requiresAdmin || isAdmin),
        );
        if (items.length === 0) return null;
        return (
        <div key={i} className="flex flex-col gap-0.5">
          {/* Divider between groups (Vercel-style), in place of section titles. */}
          {i > 0 && (
            <hr
              className={cn(
                "my-2 border-t border-sidebar-border",
                collapsed ? "mx-1" : "mx-2"
              )}
            />
          )}
          {items.map((item) => {
            const active = isActive(item.href, item.exact);
            const Icon = item.icon;
            return (
              <Tooltip key={item.href} delayDuration={collapsed ? 0 : 400}>
                <TooltipTrigger asChild>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-label={item.label}
                    data-active={active ? "true" : undefined}
                    className={cn(
                      // relative z-10 keeps the label/icon above the sliding pill.
                      "group relative z-10 flex cursor-pointer items-center gap-2.5 rounded-md text-sm transition-colors",
                      collapsed ? "h-9 w-9 justify-center" : "px-3 py-1.5",
                      active
                        ? "text-foreground"
                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:bg-foreground/5"
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        active
                          ? "text-foreground"
                          : "text-muted-foreground group-hover:text-foreground"
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
        );
      })}
    </nav>
  );
}
