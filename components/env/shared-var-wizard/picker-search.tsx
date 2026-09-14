"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

// PickerSearch - the filter box every scope picker narrows its rows with.
export function PickerSearch({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-9 pl-9"
        // A filter box, not a field of the form: Enter here would otherwise
        // advance the wizard mid-search.
        onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
      />
    </div>
  );
}
