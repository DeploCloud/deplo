"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// AddressForm is the address row, shared by the states that need one.
export function AddressForm({
  value,
  onChange,
  onSubmit,
  submitLabel,
  onSecondary,
  secondaryLabel,
  working,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  onSecondary?: () => void;
  secondaryLabel?: string;
  working: boolean;
}) {
  return (
    <>
      <form
        className="flex flex-row items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {/* EMPTY, never prefilled: the address we hold is the one that just failed. */}
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="203.0.113.10"
          className="w-full"
          disabled={working}
        />
        <Button type="submit" disabled={working || !value.trim()}>
          {submitLabel}
        </Button>
        {onSecondary && (
          <Button
            type="button"
            variant="outline"
            disabled={working}
            onClick={onSecondary}
          >
            {working ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              secondaryLabel
            )}
          </Button>
        )}
      </form>
      {/* The panel is reached at a name, the machine at an IP -
          https://deplo.build/docs/migrations/move-from-dokploy */}
      <p className="text-xs text-muted-foreground">
        The machine&rsquo;s own IP address, not the panel&rsquo;s.
      </p>
    </>
  );
}
