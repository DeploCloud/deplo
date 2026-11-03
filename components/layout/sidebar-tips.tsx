"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { ShieldAlert, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUpstreamUpdate } from "./update-state";

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
  const update = useUpstreamUpdate();
  const [dismissed, setDismissed] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(readDismissed());
  }, []);

  // No dismiss: it goes away once Deplo is updated past the flaw.
  if (update?.securityFix)
    return (
      <TipCard
        icon={ShieldAlert}
        tone="destructive"
        title="Deplo security fix"
        description={`Deplo ${update.securityFix} fixes a security flaw. You are on v${update.current}.`}
        cta={{ label: "Update now", href: "/settings/deplo?tab=updates" }}
      />
    );

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

  return <TipCard {...tip} onDismiss={() => dismiss(tip.id)} />;
}

function TipCard({
  icon: Icon,
  title,
  description,
  tone = "default",
  cta,
  onDismiss,
}: Omit<SidebarTip, "id" | "when"> & { onDismiss?: () => void }) {
  const style = TONE[tone];
  return (
    <div className={cn("relative rounded-lg border p-3", style.card)}>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="absolute top-2 right-2 cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      <div className={cn("flex items-center gap-2", onDismiss && "pr-6")}>
        <Icon className={cn("size-4 shrink-0", style.icon)} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      {cta && (
        <Button
          variant={onDismiss ? "secondary" : "default"}
          size="sm"
          asChild
          className="mt-2.5 w-full"
        >
          <Link href={cta.href}>{cta.label}</Link>
        </Button>
      )}
    </div>
  );
}
