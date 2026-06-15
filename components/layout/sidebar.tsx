"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { DeploLogo, DeploMark } from "@/components/logo";
import { SidebarNav } from "./sidebar-nav";
import { StatusDot } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Server } from "@/lib/types";

const COLLAPSE_KEY = "deplo:sidebar-collapsed";
const WIDTH_KEY = "deplo:sidebar-width";
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;

const clampWidth = (n: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));

/**
 * Desktop sidebar. Collapses fully to zero width (with a floating expand
 * handle) and, when open, can be dragged wider or narrower within
 * [MIN_WIDTH, MAX_WIDTH]. Both the collapsed flag and the chosen width persist
 * in localStorage; the width transition is suppressed during a drag and on
 * first paint so neither animates unexpectedly.
 */
export function Sidebar({ server }: { server: Server | null }) {
  const router = useRouter();
  const [state, setState] = React.useState({
    collapsed: false,
    hydrated: false,
    width: DEFAULT_WIDTH,
  });
  const [dragging, setDragging] = React.useState(false);
  const { collapsed, hydrated, width } = state;
  const widthRef = React.useRef(DEFAULT_WIDTH);
  const [query, setQuery] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    let storedCollapsed = false;
    let storedWidth = DEFAULT_WIDTH;
    try {
      storedCollapsed = window.localStorage.getItem(COLLAPSE_KEY) === "1";
      const w = Number(window.localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(w) && w > 0) storedWidth = clampWidth(w);
    } catch {
      /* ignore */
    }
    widthRef.current = storedWidth;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- apply persisted UI preference after mount
    setState({ collapsed: storedCollapsed, hydrated: true, width: storedWidth });
  }, []);

  const toggle = React.useCallback(() => {
    setState((prev) => {
      const next = !prev.collapsed;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return { ...prev, collapsed: next };
    });
  }, []);

  // Keyboard shortcuts: "[" toggles the sidebar, "/" focuses search.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "[" && !typing) {
        e.preventDefault();
        toggle();
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    setDragging(true);

    function onMove(ev: PointerEvent) {
      const w = clampWidth(ev.clientX);
      widthRef.current = w;
      setState((prev) => ({ ...prev, width: w }));
    }
    function onUp() {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        window.localStorage.setItem(WIDTH_KEY, String(widthRef.current));
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/?q=${encodeURIComponent(q)}` : "/");
  }

  return (
    <>
      <aside
        data-collapsed={collapsed}
        style={{ width: collapsed ? 0 : width }}
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar md:flex",
          hydrated && !dragging && "transition-[width] duration-200 ease-out",
          collapsed && "border-r-0",
        )}
      >
        <div
          className={cn(
            "flex h-14 items-center",
            collapsed ? "justify-center px-2" : "px-5",
          )}
        >
          <Link href="/" className="cursor-pointer" aria-label="Deplo home">
            {collapsed ? <DeploMark /> : <DeploLogo />}
          </Link>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <form onSubmit={submitSearch} className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              className="h-9 pl-8 pr-7"
            />
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 text-[10px] text-muted-foreground lg:inline">
              /
            </kbd>
          </form>
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
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                >
                  <StatusDot status={server.status} />
                  <span className="truncate">{server.name}</span>
                  <span className="ml-auto tabular-nums">
                    {server.cpuUsage}% CPU
                  </span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">
                {server.name} {server.cpuUsage}% CPU
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        <div className="flex justify-end border-t border-sidebar-border p-2">
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggle}
                aria-label="Collapse sidebar"
                className="text-muted-foreground"
              >
                <PanelLeftClose className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              Collapse sidebar
              <kbd className="ml-1.5 rounded border border-border bg-muted px-1 text-[10px]">
                [
              </kbd>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Drag-to-resize handle on the right edge */}
        <div
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className={cn(
            "absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize touch-none transition-colors hover:bg-foreground/15",
            dragging && "bg-foreground/25",
          )}
        />
      </aside>

      {/* Floating expand control — only handle left when fully collapsed */}
      {collapsed && (
        <Tooltip delayDuration={400}>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={toggle}
              aria-label="Expand sidebar"
              className="fixed bottom-3 left-3 z-40 hidden bg-background shadow-sm md:flex"
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            Expand sidebar
            <kbd className="ml-1.5 rounded border border-border bg-muted px-1 text-[10px]">
              [
            </kbd>
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
