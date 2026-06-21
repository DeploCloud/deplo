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

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <nav className={cn("flex flex-col py-3", collapsed ? "px-2" : "px-3", slide)}>
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
                    className={cn(
                      "group flex cursor-pointer items-center gap-2.5 rounded-md text-sm transition-colors",
                      collapsed ? "h-9 w-9 justify-center" : "px-3 py-1.5",
                      active
                        ? "bg-sidebar-accent font-medium text-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
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
