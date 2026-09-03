"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/result";
import {
  overrideValue,
  settleOverride,
  type ValueOverride,
} from "@/lib/optimistic-value";

/**
 * Optimistic edit: the new name, the flipped switch, the picked colour are on
 * screen on the CLICK, and the mutation settles behind them.
 */
export function useOptimisticValue<T>(serverValue: T): [
  T,
  (
    next: T,
    mutate: () => Promise<ActionResult<unknown>>,
    opts?: {
      /** Toasted when the server confirms, never on the click, so a toast
       *  never claims something the server went on to refuse. */
      success?: string;
      /** Called with the server's message after it has been toasted. */
      onError?: (error: string) => void;
    },
  ) => void,
] {
  const router = useRouter();
  const [override, setOverride] = React.useState<ValueOverride<T>>(null);
  const [, startTransition] = React.useTransition();

  // Retire the override once the server has moved off the value it was taken against.
  const settled = settleOverride(override, serverValue);
  if (settled !== override) setOverride(settled);

  function apply(
    next: T,
    mutate: () => Promise<ActionResult<unknown>>,
    opts?: { success?: string; onError?: (error: string) => void },
  ) {
    setOverride({ base: serverValue, value: next });
    startTransition(async () => {
      const res = await mutate();
      if (!res.ok) {
        setOverride(null);
        toast.error(res.error);
        opts?.onError?.(res.error);
      } else if (opts?.success) {
        toast.success(opts.success);
      }
      // Refresh either way: several of these mutations write the row first and
      // fail later, on the part that talks to the server agent - an error can
      // still leave a change the user has to see.
      router.refresh();
    });
  }

  return [overrideValue(settled, serverValue), apply];
}
