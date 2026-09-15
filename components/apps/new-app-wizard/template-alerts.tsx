"use client";

import { Info, OctagonAlert, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

import type { WizardTemplate } from "./types";

export function TemplateAlerts({
  alerts,
}: {
  alerts: WizardTemplate["alerts"];
}) {
  if (!alerts.length) return null;

  const styles = {
    info: {
      icon: Info,
      className: "border-info/40 bg-info-wash-strong text-info",
    },
    warning: {
      icon: TriangleAlert,
      className: "border-warning/40 bg-warning-wash-strong text-warning",
    },
    destructive: {
      icon: OctagonAlert,
      className:
        "border-destructive/40 bg-destructive-wash-strong text-destructive",
    },
  } as const;

  return (
    <div className="space-y-2">
      {alerts.map((alert, index) => {
        const style = styles[alert.type];
        const Icon = style.icon;
        return (
          <div
            key={`${alert.type}-${index}`}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm",
              style.className,
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0">
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
            </p>
          </div>
        );
      })}
    </div>
  );
}
