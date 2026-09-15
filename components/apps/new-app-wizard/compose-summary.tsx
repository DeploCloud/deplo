"use client";

import { FileText, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { LintDiagnostic } from "@/lib/deploy/compose-lint/lint";

export function ComposeSummary({
  services,
  diagnostics,
  onOpen,
}: {
  services: string[];
  diagnostics: LintDiagnostic[];
  onOpen: () => void;
}) {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="flex min-w-0 items-center gap-3">
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {services.length === 0
              ? "No stack yet"
              : `${services.length} service${services.length === 1 ? "" : "s"}`}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {errors > 0
              ? `${errors} error${errors === 1 ? "" : "s"} to fix`
              : services.length === 0
                ? "Paste or write your docker-compose.yml"
                : services.join(", ")}
          </p>
        </div>
      </div>
      <Button type="button" variant="outline" onClick={onOpen}>
        {services.length === 0 ? (
          <>
            <FileText className="size-4" />
            Write compose
          </>
        ) : (
          <>
            <Pencil className="size-4" />
            Edit compose
          </>
        )}
      </Button>
    </div>
  );
}
