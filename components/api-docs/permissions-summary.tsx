"use client";

import { Check, X, ShieldCheck } from "lucide-react";
import { ALL_CAPABILITIES, type Capability } from "@/lib/types";
import { CAPABILITY_META } from "@/lib/membership-shared";
import { cn } from "@/lib/utils";

/**
 * A consolidated, text-labelled view of what the current viewer can do — so the
 * held/not-held signal isn't conveyed by badge colour alone (an accessibility
 * gap on the per-field badges). Lists every capability with an explicit
 * ✓ Granted / ✗ Not granted label, plus the instance-admin flag.
 */
export function PermissionsSummary({
  capabilities,
  isInstanceAdmin,
}: {
  capabilities: Capability[];
  isInstanceAdmin: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Your API permissions</h3>
          <p className="text-xs text-muted-foreground">
            What your account can call in the active team. Mutations you lack are
            denied (in the playground and the real API alike).
          </p>
        </div>
        {isInstanceAdmin && (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--success)]/40 px-2.5 py-1 text-xs font-medium text-[var(--success)]">
            <ShieldCheck className="size-3.5" />
            Instance admin
          </span>
        )}
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {ALL_CAPABILITIES.map((cap) => {
          const held = capabilities.includes(cap);
          const meta = CAPABILITY_META[cap];
          return (
            <li
              key={cap}
              className="flex items-start gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5"
            >
              {held ? (
                <Check
                  className="mt-0.5 size-4 shrink-0 text-[var(--success)]"
                  aria-hidden
                />
              ) : (
                <X
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              )}
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  {meta.label}{" "}
                  <span
                    className={cn(
                      "font-normal",
                      held
                        ? "text-[var(--success)]"
                        : "text-muted-foreground",
                    )}
                  >
                    — {held ? "Granted" : "Not granted"}
                  </span>
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {meta.description}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
