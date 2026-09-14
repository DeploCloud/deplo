import * as React from "react";

import { FieldLabel } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import type { DocsTopic } from "@/lib/docs";

// SettingRow - one setting: its name on the left, its control on the right, its explanation in the tooltip.
export function SettingRow({
  label,
  icon: Icon,
  info,
  docs,
  htmlFor,
  align = "center",
  className,
  children,
}: {
  label: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  info?: React.ReactNode;
  docs?: DocsTopic;
  htmlFor?: string;
  align?: "center" | "start";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border p-3",
        "sm:flex-row sm:justify-between sm:gap-4",
        align === "center" ? "sm:items-center" : "sm:items-start",
        className,
      )}
    >
      <FieldLabel
        htmlFor={htmlFor}
        info={info}
        docs={docs}
        className={align === "start" ? "sm:pt-2" : undefined}
      >
        {Icon && <Icon aria-hidden className="size-3.5 shrink-0 opacity-50" />}
        {label}
      </FieldLabel>
      {/* A flex basis, not a width, so a narrow grid shrinks the column instead of crushing the label. */}
      <div className="flex w-full min-w-0 justify-end sm:basis-72">
        {children}
      </div>
    </div>
  );
}
