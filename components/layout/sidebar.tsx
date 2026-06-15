"use client";

import * as React from "react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { DeploLogo, DeploMark } from "@/components/logo";
import { SidebarNav } from "./sidebar-nav";
import { StatusDot } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Server } from "@/lib/types";

const STORAGE_KEY = "deplo:sidebar-collapsed";

/**
 * Desktop sidebar with a persisted collapse state. Collapsed mode shows
 * icon-only navigation with tooltips; the width animates between states so
 * navigation stays fluid and the shell never reloads.
 */
export function Sidebar({ server }: { server: Server | null }) {
  // `hydrated` guards the width transition so the persisted state does not
  // animate on first paint. localStorage is only available after mount, so the
  // value is read in an effect.
  const [state, setState] = React.useState({ collapsed: false, hydrated: false });
  const { collapsed, hydrated } = state;

  React.useEffect(() => {
    let stored = false;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- apply persisted UI preference after mount
    setState({ collapsed: stored, hydrated: true });
  }, []);

  const toggle = React.useCallback(() => {
    setState((prev) => {
      const next = !prev.collapsed;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return { ...prev, collapsed: next };
    });
  }, []);

  // Keyboard shortcut: "[" toggles the sidebar.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "[" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex",
        hydrated && "transition-[width] duration-200 ease-out",
        collapsed ? "w-15" : "w-60"
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center",
          collapsed ? "justify-center px-2" : "px-5"
        )}
      >
        <Link href="/" className="cursor-pointer" aria-label="Deplo home">
          {collapsed ? <DeploMark /> : <DeploLogo />}
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <SidebarNav collapsed={collapsed} />
      </div>

      {server && (
        <div className="border-t border-sidebar-border p-2">
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <Link
                href="/servers"
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                  collapsed && "justify-center"
                )}
              >
                <StatusDot status={server.status} />
                {!collapsed && (
                  <>
                    <span className="truncate">{server.name}</span>
                    <span className="ml-auto tabular-nums">
                      {server.cpuUsage}% CPU
                    </span>
                  </>
                )}
              </Link>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right">
                {server.name} — {server.cpuUsage}% CPU
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      )}

      <div
        className={cn(
          "border-t border-sidebar-border p-2",
          collapsed ? "flex justify-center" : "flex justify-end"
        )}
      >
        <Tooltip delayDuration={400}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggle}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="text-muted-foreground"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {collapsed ? "Expand" : "Collapse"} sidebar
            <kbd className="ml-1.5 rounded border border-border bg-muted px-1 text-[10px]">
              [
            </kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
