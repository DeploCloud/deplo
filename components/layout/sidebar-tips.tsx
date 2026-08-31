"use client";

import * as React from "react";
import Link from "next/link";
import { ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/** One card. */
export interface SidebarTip {
  /** Also the dismissal key: change it to show a rewritten tip again. */
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  /** At most one, always secondary. */
  cta?: { label: string; href: string };
  when: (ctx: SidebarTipContext) => boolean;
}

export interface SidebarTipContext {
  hasSecondFactor: boolean;
  capabilities: string[];
  isAdmin: boolean;
}

/** In order: the first one that applies and has not been dismissed is shown. */
export const SIDEBAR_TIPS: SidebarTip[] = [
  {
    id: "two-factor",
    icon: ShieldCheck,
    title: "Turn on two-factor",
    description:
      "A code from your phone on top of your password, so a stolen one is not enough.",
    cta: { label: "Set it up", href: "/settings/security" },
    when: (ctx) => !ctx.hasSecondFactor,
  },
];

/** The card to show right now, if any. */
export function nextTip(
  dismissed: string[],
  ctx: SidebarTipContext,
): SidebarTip | null {
  return (
    SIDEBAR_TIPS.find((t) => !dismissed.includes(t.id) && t.when(ctx)) ?? null
  );
}

/** Dismissal is LOCAL: a card closed on one laptop has no business following
 *  the account to the next one. */
const KEY = "deplo:sidebar-tips";

function readDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    /* blocked or corrupt storage - the card simply shows */
    return [];
  }
}

export function SidebarTips(ctx: SidebarTipContext) {
  const [dismissed, setDismissed] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(readDismissed());
  }, []);

  // `null` is "not read yet": rendering before the stored answer is in would
  // flash a card the user closed on the last page.
  if (dismissed === null) return null;
  const tip = nextTip(dismissed, ctx);
  if (!tip) return null;

  function dismiss(id: string) {
    const next = [...(dismissed ?? []), id];
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* nothing to remember, and nothing to break */
    }
    setDismissed(next);
  }

  const Icon = tip.icon;

  return (
    <div className="relative rounded-lg border border-border bg-card p-3">
      <button
        type="button"
        onClick={() => dismiss(tip.id)}
        aria-label="Dismiss"
        className="absolute top-2 right-2 cursor-pointer text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
      <div className="flex items-center gap-2 pr-6">
        <Icon className="size-4 shrink-0" />
        <span className="text-sm font-medium">{tip.title}</span>
      </div>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">
        {tip.description}
      </p>
      {tip.cta && (
        <Button variant="secondary" size="sm" asChild className="mt-2.5 w-full">
          <Link href={tip.cta.href}>{tip.cta.label}</Link>
        </Button>
      )}
    </div>
  );
}
