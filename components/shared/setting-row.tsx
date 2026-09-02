import * as React from "react";

import { FieldLabel } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import type { DocsTopic } from "@/lib/docs";

/**
 * One setting: its name on the left, its control on the right. The explanation
 * is the label's tooltip, never a line underneath - a settings page reads as a
 * list of what you can change, not as a document about it.
 */
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
  /** A mark for the setting, held back so the label stays the thing you read. */
  icon?: React.ComponentType<{ className?: string }>;
  /** The constraint or the reason, in the label's tooltip. */
  info?: React.ReactNode;
  docs?: DocsTopic;
  htmlFor?: string;
  /** `start` for a control taller than one line (a textarea, a stack). */
  align?: "center" | "start";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // Stacked on a phone, side by side from `sm`. A fixed control column is what
    // sends a settings page into horizontal overflow on a 375px viewport, so it
    // only exists once there is room for it.
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
      {/* One control column for every row, so a page of rows lines up by
          construction instead of each caller picking its own max-width. A
          control that wants the whole column asks with `w-full`; a switch stays
          right-aligned in it. */}
      <div className="flex w-full min-w-0 justify-end sm:w-72 sm:shrink-0">
        {children}
      </div>
    </div>
  );
}
