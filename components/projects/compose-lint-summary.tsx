"use client";

import * as React from "react";
import { CircleX, TriangleAlert, Info, CircleCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LintDiagnostic, LintSeverity } from "@/lib/deploy/compose-lint";

/**
 * Compact summary of the compose linter's diagnostics, shown under the editor.
 * Counts by severity in a header row, then lists each problem with its line —
 * clicking nothing here (the gutter markers carry the in-editor affordance),
 * this is the scannable overview and the "all clear" state.
 */

const META: Record<
  LintSeverity,
  { icon: React.ComponentType<{ className?: string }>; tone: string; label: string }
> = {
  error: { icon: CircleX, tone: "text-destructive", label: "error" },
  warning: { icon: TriangleAlert, tone: "text-[var(--warning,#d97706)]", label: "warning" },
  info: { icon: Info, tone: "text-muted-foreground", label: "hint" },
};

export function ComposeLintSummary({
  diagnostics,
}: {
  diagnostics: LintDiagnostic[];
}) {
  const counts = React.useMemo(() => {
    const c: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
    for (const d of diagnostics) c[d.severity]++;
    return c;
  }, [diagnostics]);

  if (diagnostics.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-[var(--success)]">
        <CircleCheck className="size-3.5" />
        No problems detected.
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2">
      <div className="flex items-center gap-3 text-xs font-medium">
        {(["error", "warning", "info"] as const).map((sev) =>
          counts[sev] > 0 ? (
            <span key={sev} className={cn("flex items-center gap-1", META[sev].tone)}>
              {React.createElement(META[sev].icon, { className: "size-3.5" })}
              {counts[sev]} {META[sev].label}
              {counts[sev] > 1 ? "s" : ""}
            </span>
          ) : null,
        )}
      </div>
      <ul className="space-y-0.5">
        {diagnostics.map((d, i) => {
          const Icon = META[d.severity].icon;
          return (
            <li
              key={`${d.rule}-${d.line}-${i}`}
              className="flex items-start gap-1.5 text-xs text-muted-foreground"
            >
              <Icon className={cn("mt-0.5 size-3 shrink-0", META[d.severity].tone)} />
              <span>
                <span className="font-mono text-[10px] text-muted-foreground/70">
                  L{d.line}
                </span>{" "}
                <span className="whitespace-pre-wrap">{d.message}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
