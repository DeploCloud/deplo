"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The step rail shared by the dialog wizards: where you are, what's left, and a
 * way back to a step you already finished.
 */
export interface WizardStep<T extends string> {
  id: T;
  label: string;
}

export function WizardStepper<T extends string>({
  steps,
  current,
  reachable,
  onSelect,
}: {
  steps: WizardStep<T>[];
  current: T;
  /** A step is normally reachable once every step before it is complete. */
  reachable: (s: T) => boolean;
  onSelect: (s: T) => void;
}) {
  const at = steps.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center gap-1">
      {steps.map((s, i) => {
        const done = i < at;
        const active = i === at;
        const open = reachable(s.id);
        return (
          <li key={s.id} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <span aria-hidden className="w-3 border-t border-border" />
            )}
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              disabled={!open}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                active
                  ? "bg-secondary font-medium text-foreground"
                  : open
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground/50",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : done
                      ? "border-primary/40 text-primary"
                      : "border-border",
                )}
              >
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              {/* Numbers only on a narrow viewport: four labelled chips do not
                  fit a phone-width dialog, and a rail that overflows is worse
                  than one that leans on its numbers. Still announced. */}
              <span className="truncate max-sm:sr-only">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
