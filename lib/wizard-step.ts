"use client";

import * as React from "react";
import { useSearchParams } from "@/lib/nav";

/** The step the address asked for, or the nearest one before it the wizard can show; else `fallback`. */
export function clampStep<S extends string>(
  steps: readonly S[],
  requested: string | null,
  reachable: (step: S) => boolean,
  fallback: S,
): S {
  const at = steps.indexOf(requested as S);
  for (let i = at; i >= 0; i--) if (reachable(steps[i]!)) return steps[i]!;
  return fallback;
}

// The live address on the client: a replaceState right before a remount has not reached the router yet.
export function useInitialParam(key: string): string | null {
  const params = useSearchParams();
  const [value] = React.useState(() =>
    typeof window === "undefined"
      ? params.get(key)
      : new URLSearchParams(window.location.search).get(key),
  );
  return value;
}

/** Writes one search param in place, without a navigation; null removes it. */
export function setSearchParam(key: string, value: string | null): void {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  if (url.href !== window.location.href)
    window.history.replaceState(null, "", url);
}

/**
 * A page wizard's step, kept in `?step=`. The wizard calls `settle` once it knows what it can
 * show: a step the address asks for too early falls back to the nearest reachable one before it.
 */
export function useUrlStep<S extends string>(
  initial: S | (() => S),
  inUrl = true,
) {
  const fromUrl = useInitialParam("step");
  const requested = inUrl ? fromUrl : null;
  const [step, setStep] = React.useState<S>(initial);
  const [settled, setSettled] = React.useState(requested === null);

  React.useEffect(() => {
    if (inUrl && settled) setSearchParam("step", step);
  }, [inUrl, settled, step]);

  function settle(steps: readonly S[], reachable: (step: S) => boolean) {
    if (settled) return;
    setSettled(true);
    const target = clampStep(steps, requested, reachable, step);
    if (target !== step) setStep(target);
  }

  return { step, setStep, settle };
}
