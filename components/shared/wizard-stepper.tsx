"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";

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
  compact = false,
}: {
  steps: WizardStep<T>[];
  current: T;
  /** A step is normally reachable once every step before it is complete. */
  reachable: (s: T) => boolean;
  onSelect: (s: T) => void;
  /**
   * Dots, with only the step you are on named under them. For a rail long
   * enough that a row of labelled chips outgrows the column it sits above.
   */
  compact?: boolean;
}) {
  const at = steps.findIndex((s) => s.id === current);
  if (compact)
    return (
      <CompactStepper
        steps={steps}
        at={at}
        reachable={reachable}
        onSelect={onSelect}
      />
    );
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
                    ? "border-primary bg-primary-wash-strong text-primary"
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

/** The dot rail: the name only where you are, every other step a hover away. */
function CompactStepper<T extends string>({
  steps,
  at,
  reachable,
  onSelect,
}: {
  steps: WizardStep<T>[];
  at: number;
  reachable: (s: T) => boolean;
  onSelect: (s: T) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <ol className="flex items-center">
        {steps.map((s, i) => {
          const done = i < at;
          const active = i === at;
          const open = reachable(s.id);
          return (
            <li key={s.id} className="flex items-center">
              {i > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    "h-px w-6 transition-colors",
                    done || active ? "bg-primary" : "bg-border",
                  )}
                />
              )}
              <SimpleTooltip content={s.label}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  disabled={!open}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full border transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : done
                        ? "border-primary/40 text-primary"
                        : "border-transparent",
                    open && !active && "hover:border-primary/60",
                  )}
                >
                  {done ? (
                    <Check className="size-2.5" />
                  ) : (
                    !active && (
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full bg-border"
                      />
                    )
                  )}
                  <span className="sr-only">{s.label}</span>
                </button>
              </SimpleTooltip>
            </li>
          );
        })}
      </ol>
      <span className="text-xs font-medium text-foreground">
        {steps[at]?.label}
      </span>
    </div>
  );
}
