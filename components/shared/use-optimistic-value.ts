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

// useOptimisticValue - the edit is on screen on the click, and the mutation settles behind it.
export function useOptimisticValue<T>(serverValue: T): [
  T,
  (
    next: T,
    mutate: () => Promise<ActionResult<unknown>>,
    opts?: {
      success?: string;
      onError?: (error: string) => void;
    },
  ) => void,
] {
  const router = useRouter();
  const [override, setOverride] = React.useState<ValueOverride<T>>(null);
  const [, startTransition] = React.useTransition();

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
      // Refresh either way: these mutations write the row first and can fail later, at the server agent.
      router.refresh();
    });
  }

  return [overrideValue(settled, serverValue), apply];
}
