"use client";

import type * as React from "react";
import {
  ChevronDown,
  Info,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import type { WizardTemplate } from "./types";

type AlertType = WizardTemplate["alerts"][number]["type"];

export interface WizardAlert {
  type: AlertType;
  content: React.ReactNode;
  icon?: LucideIcon;
}

const STYLES = {
  info: {
    icon: Info,
    box: "border-info/40 bg-info-wash-strong",
    text: "text-info",
  },
  warning: {
    icon: TriangleAlert,
    box: "border-warning/40 bg-warning-wash-strong",
    text: "text-warning",
  },
  destructive: {
    icon: OctagonAlert,
    box: "border-destructive/40 bg-destructive-wash-strong",
    text: "text-destructive",
  },
} as const;

const SEVERITY: AlertType[] = ["info", "warning", "destructive"];

export function templateAlert(
  alert: WizardTemplate["alerts"][number],
): WizardAlert {
  return {
    type: alert.type,
    content: (
      <>
        {alert.message}{" "}
        {alert.link && (
          <a
            href={alert.link}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
          >
            Learn more
          </a>
        )}
      </>
    ),
  };
}

export function WizardAlerts({ alerts }: { alerts: WizardAlert[] }) {
  if (!alerts.length) return null;

  if (alerts.length === 1) {
    const style = STYLES[alerts[0]!.type];
    return (
      <div
        className={cn(
          "rounded-lg border px-3.5 py-2.5 text-sm",
          style.box,
          style.text,
        )}
      >
        <AlertRow alert={alerts[0]!} />
      </div>
    );
  }

  const worst = alerts.reduce<AlertType>(
    (w, a) => (SEVERITY.indexOf(a.type) > SEVERITY.indexOf(w) ? a.type : w),
    "info",
  );
  const style = STYLES[worst];
  const Icon = style.icon;
  return (
    <details
      className={cn("group rounded-lg border px-3.5 py-2.5 text-sm", style.box)}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden",
          style.text,
        )}
      >
        <Icon className="size-4 shrink-0" />
        {alerts.length} {worst === "info" ? "notes" : "warnings"}
        <ChevronDown className="ml-auto size-4 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2.5 space-y-2">
        {alerts.map((alert, index) => (
          <AlertRow
            key={index}
            alert={alert}
            className={STYLES[alert.type].text}
          />
        ))}
      </div>
    </details>
  );
}

function AlertRow({
  alert,
  className,
}: {
  alert: WizardAlert;
  className?: string;
}) {
  const Icon = alert.icon ?? STYLES[alert.type].icon;
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0">{alert.content}</p>
    </div>
  );
}
