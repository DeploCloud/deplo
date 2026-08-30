"use client";

import { KeyRound } from "lucide-react";

import { Switch } from "@/components/ui/switch";

/**
 * The "Secret" toggle every variable form ends with - the app's own variables and
 * a preview override alike.
 */
export function SecretRow({
  secret,
  onChange,
}: {
  secret: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm leading-none font-medium">Secret</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Hide the value in the UI after saving. It can never be read back or
            edited.
          </p>
        </div>
      </div>
      <Switch checked={secret} onCheckedChange={onChange} aria-label="Secret" />
    </div>
  );
}
