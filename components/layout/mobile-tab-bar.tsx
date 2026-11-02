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
  MOBILE_TABS,
  type MobileTabId,
} from "./nav-config/mobile-tabs";

// Below md the sidebar gives way to this floating pill; it steps aside while the keyboard is up.
export function MobileTabBar({
  moreOpen,
  onMore,
  onNavigate,
}: {
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
  const keyboard = useKeyboardOpen();
  const navRef = React.useRef<HTMLElement | null>(null);
  const rect = useSlidingRect(
    navRef,
    () =>
      navRef.current?.querySelector<HTMLElement>('[data-active="true"]') ??
      null,
    [active, keyboard],
  );

  return (
    <nav
      ref={navRef}
      aria-label="Main"
      className={cn(
        "fixed inset-x-3.5 bottom-[max(12px,env(safe-area-inset-bottom))] isolate z-40 grid h-16 grid-cols-4 gap-0.5 rounded-full border border-border bg-card p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.18)] max-[359px]:inset-x-2.5 max-[359px]:p-1 md:hidden dark:shadow-[0_12px_32px_rgb(0_0_0/0.7)]",
        keyboard && "hidden",
      )}
    >
      <SlidingBackground
        rect={rect}
        className="top-[-1px] left-[-1px] rounded-full bg-[color-mix(in_srgb,var(--foreground)_12%,var(--card))]"
      />
      {MOBILE_TABS.map((tab) => {
        const on = tab.id === active;
        const className = cn(
          "relative z-10 flex min-w-0 cursor-pointer flex-col items-center justify-center gap-[3px] rounded-full text-[0.6875rem] font-medium tracking-tight text-muted-foreground transition-colors duration-300 outline-none focus-visible:ring-2 focus-visible:ring-ring min-[360px]:text-xs",
          on && "text-foreground",
        );
        const body = (
          <>
            <tab.icon className="size-[22px]" />
            <span className="max-w-full truncate">{tab.label}</span>
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
