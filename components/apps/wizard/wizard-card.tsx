"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, Loader2, Rocket } from "lucide-react";

import { AnimatedHeight } from "@/components/shared/animated-height";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type StepDirection = "forward" | "back";

const OUT_MS = 160;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

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
  icon?: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  backLabel?: string;
  onBack?: () => void;
  nextLabel?: string;
  onNext?: () => void;
  nextDisabled?: boolean;
  deploy?: boolean;
  pending?: boolean;
}) {
  return (
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
