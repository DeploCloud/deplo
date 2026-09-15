"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SidebarTip {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  tone?: SidebarTipTone;
  cta?: { label: string; href: string };
  when: (ctx: SidebarTipContext) => boolean;
}

export type SidebarTipTone =
  "default" | "info" | "success" | "warning" | "destructive";

const TONE: Record<SidebarTipTone, { card: string; icon: string }> = {
  default: { card: "border-border bg-card", icon: "" },
  info: { card: "border-info/40 bg-info-wash", icon: "text-info" },
  success: { card: "border-success/40 bg-success-wash", icon: "text-success" },
  warning: {
    card: "border-warning/40 bg-warning-wash-strong",
    icon: "text-warning",
  },
  destructive: {
    card: "border-destructive/40 bg-destructive-wash-strong",
    icon: "text-destructive",
  },
};

export interface SidebarTipContext {
  hasSecondFactor: boolean;
  capabilities: string[];
  isAdmin: boolean;
}

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

export function nextTip(
  dismissed: string[],
  ctx: SidebarTipContext,
): SidebarTip | null {
  return (
    SIDEBAR_TIPS.find((t) => !dismissed.includes(t.id) && t.when(ctx)) ?? null
  );
}

const KEY = "deplo:sidebar-tips";

function readDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function SidebarTips(ctx: SidebarTipContext) {
  const [dismissed, setDismissed] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(readDismissed());
  }, []);

  if (dismissed === null) return null;
  const tip = nextTip(dismissed, ctx);
  if (!tip) return null;

  function dismiss(id: string) {
    const next = [...(dismissed ?? []), id];
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
    setDismissed(next);
  }

  const Icon = tip.icon;
  const tone = TONE[tip.tone ?? "default"];

  return (
    <div className={cn("relative rounded-lg border p-3", tone.card)}>
      <button
        type="button"
        onClick={() => dismiss(tip.id)}
        aria-label="Dismiss"
        className="absolute top-2 right-2 cursor-pointer text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
      <div className="flex items-center gap-2 pr-6">
        <Icon className={cn("size-4 shrink-0", tone.icon)} />
        <span className="text-sm font-medium">{tip.title}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{tip.description}</p>
      {tip.cta && (
        <Button variant="secondary" size="sm" asChild className="mt-2.5 w-full">
          <Link href={tip.cta.href}>{tip.cta.label}</Link>
        </Button>
      )}
    </div>
  );
}
