"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import type { DocsTopic } from "@/lib/docs";
import { cn } from "@/lib/utils";

// Field is a labelled input whose help lives in the label's tooltip, never below it.
export function Field({
  label,
  optional,
  info,
  docs,
  value,
  onChange,
  placeholder,
  prefix,
  invalid,
}: {
  label: string;
  optional?: boolean;
  info: string;
  docs?: DocsTopic;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  prefix?: string;
  invalid?: boolean;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <FieldLabel className="text-xs" htmlFor={id} info={info} docs={docs}>
        {label}
        {optional && (
          <span className="text-xs font-normal text-muted-foreground">
            (optional)
          </span>
        )}
      </FieldLabel>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-xs font-medium text-muted-foreground">
            {prefix}
          </span>
        )}
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          className={cn(
            "font-mono text-sm",
            prefix && "pl-14",
            invalid && "border-destructive focus-visible:ring-destructive/40",
          )}
        />
      </div>
    </div>
  );
}
