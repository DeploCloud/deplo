"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";

/**
 * A build or start command, prefilled with what the repository declares for
 * itself. Empty is a real answer - it means the builder decides - so Reset
 * clears the field rather than putting the detected value back.
 */
export function CommandField({
  id,
  label,
  info,
  value,
  onChange,
  detected,
  placeholder,
}: {
  id: string;
  label: string;
  info: string;
  value: string;
  onChange: (value: string) => void;
  /** Where the current value came from, when it was read rather than typed. */
  detected: string | null;
  placeholder: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id} info={info} docs="build.fields">
          {label}
        </FieldLabel>
        {detected && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-2 py-1 text-xs"
            onClick={() => onChange("")}
          >
            Reset
          </Button>
        )}
      </div>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-sm"
      />
      {detected && (
        <p className="mt-1 text-xs text-muted-foreground">
          Read from package.json
        </p>
      )}
    </div>
  );
}
