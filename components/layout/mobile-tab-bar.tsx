"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useFlatPathname } from "@/lib/nav";
import { cn } from "@/lib/utils";
import {
  SlidingBackground,
  useSlidingRect,
} from "@/components/ui/sliding-underline";
import {
  activeMobileTab,
  visibleMobileTabs,
  type MobileTabId,
} from "./nav-config/mobile-tabs";

// Below md the sidebar gives way to this floating pill; it steps aside while the keyboard is up.
export function MobileTabBar({
  capabilities,
  moreOpen,
  onMore,
  onNavigate,
}: {
  capabilities: string[];
  moreOpen: boolean;
  onMore: () => void;
  onNavigate: () => void;
}) {
  const pathname = useFlatPathname();
  // The tapped tab lights up at once; the route catches up when the page has loaded.
  const [tapped, setTapped] = React.useState<MobileTabId | null>(null);
  const [tappedOn, setTappedOn] = React.useState(pathname);
  if (tappedOn !== pathname) {
    setTappedOn(pathname);
    setTapped(null);
  }
  const active = moreOpen ? "more" : (tapped ?? activeMobileTab(pathname));
  const tabs = visibleMobileTabs(new Set(capabilities));
  const keyboard = useKeyboardOpen();
  const navRef = React.useRef<HTMLElement | null>(null);
  const rect = useSlidingRect(
    navRef,
    () =>
      navRef.current?.querySelector<HTMLElement>('[data-active="true"]') ??
      null,
    [active, tabs.length, keyboard],
  );

  return (
    <nav
      ref={navRef}
      aria-label="Main"
      className={cn(
        "fixed inset-x-3.5 bottom-[max(12px,env(safe-area-inset-bottom))] isolate z-40 flex h-16 gap-0.5 rounded-full border border-border bg-card p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.18)] md:hidden dark:shadow-[0_12px_32px_rgb(0_0_0/0.7)]",
        keyboard && "hidden",
      )}
    >
      <SlidingBackground
        rect={rect}
        className="top-[-1px] left-[-1px] rounded-full bg-[color-mix(in_srgb,var(--foreground)_12%,var(--card))]"
      />
      {tabs.map((tab) => {
        const on = tab.id === active;
        const className = cn(
          "relative z-10 flex flex-auto cursor-pointer flex-col items-center justify-center gap-[3px] rounded-full px-1 text-[11px] font-medium whitespace-nowrap text-muted-foreground transition-colors duration-300 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          on && "text-foreground",
        );
        const body = (
          <>
            <tab.icon className="size-[22px]" />
            <span>{tab.label}</span>
          </>
        );
        return tab.href ? (
          <Link
            key={tab.id}
            href={tab.href}
            className={className}
            aria-current={on ? "page" : undefined}
            data-active={on ? "true" : undefined}
            onClick={() => {
              setTapped(tab.id);
              onNavigate();
            }}
          >
            {body}
          </Link>
        ) : (
          <button
            key={tab.id}
            type="button"
            className={className}
            aria-expanded={moreOpen}
            data-active={on ? "true" : undefined}
            onClick={onMore}
          >
            {body}
          </button>
        );
      })}
    </nav>
  );
}

// A focused field is not enough (pages autofocus search); the keyboard shows as a shrunken visual viewport.
function useKeyboardOpen(): boolean {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => setOpen(window.innerHeight - vv.height > 150);
    vv.addEventListener("resize", check);
    return () => vv.removeEventListener("resize", check);
  }, []);
  return open;
}
