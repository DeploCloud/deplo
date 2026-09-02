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
  info,
  docs,
  htmlFor,
  align = "center",
  className,
  children,
}: {
  label: React.ReactNode;
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
    <div
      className={cn(
        "flex justify-between gap-4 rounded-lg border border-border p-3",
        align === "center" ? "items-center" : "items-start",
        className,
      )}
    >
      <FieldLabel
        htmlFor={htmlFor}
        info={info}
        docs={docs}
        className={align === "start" ? "pt-2" : undefined}
      >
        {label}
      </FieldLabel>
      {children}
    </div>
  );
}
