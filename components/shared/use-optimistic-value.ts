"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
 *
 * The wait this replaces is the same one `useOptimisticRemove` replaces for a
 * deleted row, and it is two waits stacked: the mutation itself, and then the
 * `router.refresh()` that re-runs the page's server reads before the new value
 * can appear. A switch that answers half a second after it was flipped reads as
 * a broken switch, so the local value leads and the server confirms.
 *
 *     const [name, applyName] = useOptimisticValue(app.name);
 *     // …in the submit handler (the dialog can close right here):
 *     applyName(typed, () => gqlAction(RENAME, { id, name: typed }), {
 *       success: "App renamed",
 *     });
 *
 * If the server refuses, the override is dropped — the old value is back on
 * screen — and its message is toasted verbatim against a control the user can
 * see again. If it accepts, the override holds its ground until the refresh
 * actually brings the new value (see `settleOverride`), so nothing repaints the
 * stale one in between.
 *
 * Values are compared with `Object.is`, so this is for the ONE thing a control
 * shows: a string, a boolean, a number, an id. A form with several fields
 * already keeps what was typed in its own state — there the optimism is simply
 * not blocking the button and not holding the dialog open.
 */
export function useOptimisticValue<T>(
  serverValue: T,
): [
  T,
  (
    next: T,
    mutate: () => Promise<ActionResult<unknown>>,
    opts?: {
      /** Toasted when the server confirms — never on the click, so a toast
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

  // Retire the override once the server has moved off the value it was taken
  // against. Adjusting state during render is React's own derive-from-props
  // escape hatch; an effect would run after the commit, which is one painted
  // frame of a value the user already changed.
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
      // fail later, on the part that talks to the server agent — an error can
      // still leave a change the user has to see.
      router.refresh();
    });
  }

  return [overrideValue(settled, serverValue), apply];
}
