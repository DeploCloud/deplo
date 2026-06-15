"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "./nav-config";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function SidebarNav({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const pathname = usePathname();

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <nav className={cn("flex flex-col py-3", collapsed ? "px-2" : "px-3")}>
      {NAV.map((section, i) => (
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
          {section.items.map((item) => {
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
      ))}
    </nav>
  );
}
