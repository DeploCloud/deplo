"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, Loader2, Rocket } from "lucide-react";

import { AnimatedHeight } from "@/components/shared/animated-height";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type StepDirection = "forward" | "back";

/** How long the leaving card has the stage. Matches `.animate-step-out-*`. */
const OUT_MS = 160;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The wizard's step state plus the two-phase swap that makes the change read as
 * one card leaving and the next arriving, rather than a jump cut.
 */
export function useStepSwap<T extends string>(initial: T) {
  const [step, setStep] = React.useState<T>(initial);
  const [direction, setDirection] = React.useState<StepDirection>("forward");
  const [leaving, setLeaving] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const go = React.useCallback((next: T, dir: StepDirection) => {
    setDirection(dir);
    if (prefersReducedMotion()) {
      setStep(next);
      return;
    }
    setLeaving(true);
    timer.current = setTimeout(() => {
      setStep(next);
      setLeaving(false);
    }, OUT_MS);
  }, []);

  return { step, direction, leaving, go };
}

/**
 * The animated stage every step is drawn on: the height eases between steps
 * (and within one, when Advanced opens), the card itself slides in the direction
 * of travel.
 */
export function WizardStage({
  step,
  direction,
  leaving,
  children,
}: {
  step: string;
  direction: StepDirection;
  leaving: boolean;
  children: React.ReactNode;
}) {
  return (
    <AnimatedHeight className="w-full" scroll={false}>
      <div
        key={step}
        className={cn(
          leaving
            ? direction === "forward"
              ? "animate-step-out-up"
              : "animate-step-out-down"
            : direction === "forward"
              ? "animate-step-in-up"
              : "animate-step-in-down",
        )}
      >
        {children}
      </div>
    </AnimatedHeight>
  );
}

/**
 * One step's card. Same width in every step by construction (the parent owns the
 * measure); only the height moves. Back always bottom-left, the way forward
 * always bottom-right.
 */
export function WizardCard({
  title,
  icon,
  description,
  meta,
  children,
  backLabel = "Back",
  onBack,
  nextLabel = "Next",
  onNext,
  nextDisabled = false,
  deploy = false,
  pending = false,
}: {
  title: string;
  /** Rendered before the title - the mark of the source this step is about. */
  icon?: React.ReactNode;
  description?: React.ReactNode;
  /** A line under the description - where the app lands, which template it is. */
  meta?: React.ReactNode;
  children: React.ReactNode;
  backLabel?: string;
  /** Omitted where there is nothing behind this step - then the card has no
   *  footer at all and the only way out is the frame's own close. */
  onBack?: () => void;
  nextLabel?: string;
  /** Omitted on a step that advances on the choice itself - then the footer
   *  carries only the way back. */
  onNext?: () => void;
  nextDisabled?: boolean;
  /** The last step: the button becomes the rocket. */
  deploy?: boolean;
  pending?: boolean;
}) {
  return (
    // The card caps ITSELF and scrolls its own body, so its header and footer
    // hold their place instead of scrolling away with the fields.
    <div className="flex max-h-[calc(100dvh-10rem)] flex-col rounded-xl border border-border bg-card shadow-sm">
      <div className="shrink-0 px-6 pt-6 pb-4">
        <div className="flex items-start gap-3">
          {icon}
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold lg:text-lg">{title}</h1>
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>
        {meta && <div className="mt-3">{meta}</div>}
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
        {children}
      </div>
      {(onBack || onNext) && (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-6 py-4">
          {onBack ? (
            <Button type="button" variant="ghost" onClick={onBack}>
              <ArrowLeft className="size-4" />
              {backLabel}
            </Button>
          ) : (
            <span />
          )}
          {onNext && (
            <Button
              type="button"
              onClick={onNext}
              disabled={nextDisabled || pending}
            >
              {/* The label stays mounted while pending so the button keeps its
                width and the footer doesn't jump. */}
              <span className="grid place-items-center">
                <span
                  className={cn(
                    "col-start-1 row-start-1 flex items-center gap-2",
                    pending && "invisible",
                  )}
                >
                  {deploy ? (
                    <Rocket className="size-4" />
                  ) : (
                    <ArrowRight className="order-last size-4" />
                  )}
                  {nextLabel}
                </span>
                {pending && (
                  <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                )}
              </span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
