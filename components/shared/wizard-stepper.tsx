"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  SlidingBackground,
  useSlidingRect,
} from "@/components/ui/sliding-underline";

const SLIDE =
  "duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

function useActiveRect(
  ref: React.RefObject<HTMLOListElement | null>,
  key: string,
) {
  return useSlidingRect(
    ref,
    () =>
      ref.current?.querySelector<HTMLElement>('[aria-current="step"]') ?? null,
    [key],
  );
}

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
  reachable: (s: T) => boolean;
  onSelect: (s: T) => void;
  compact?: boolean;
}) {
  const at = steps.findIndex((s) => s.id === current);
  const ref = React.useRef<HTMLOListElement | null>(null);
  const rect = useActiveRect(ref, `${at}/${steps.length}`);
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
    <ol ref={ref} className="relative isolate flex items-center gap-1">
      <SlidingBackground rect={rect} className={cn("bg-secondary", SLIDE)} />
      {steps.map((s, i) => {
        const done = i < at;
        const active = i === at;
        const open = reachable(s.id);
        return (
          <li key={s.id} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  "w-3 border-t transition-colors",
                  SLIDE,
                  done || active ? "border-primary/40" : "border-border",
                )}
              />
            )}
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              disabled={!open}
              aria-current={active ? "step" : undefined}
              className={cn(
                "relative z-10 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                SLIDE,
                active
                  ? "font-medium text-foreground"
                  : open
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground/50",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] transition-colors",
                  SLIDE,
                  active
                    ? "border-primary bg-primary-wash-strong text-primary"
                    : done
                      ? "border-primary/40 text-primary"
                      : "border-border",
                )}
              >
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              <span className="truncate max-sm:sr-only">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

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
  const ref = React.useRef<HTMLOListElement | null>(null);
  const rect = useActiveRect(ref, `${at}/${steps.length}`);
  return (
    <div className="flex flex-col items-center gap-2">
      <ol ref={ref} className="relative isolate flex items-center">
        <SlidingBackground
          rect={rect}
          className={cn("rounded-full bg-primary", SLIDE)}
        />
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
                    SLIDE,
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
                    "relative z-10 flex size-4 items-center justify-center rounded-full border transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
                    SLIDE,
                    active
                      ? "border-primary text-primary-foreground"
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
