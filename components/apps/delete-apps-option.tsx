"use client";

import { Checkbox } from "@/components/ui/checkbox";

export function DeleteAppsOption({
  checked,
  onChange,
  count,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  count?: number;
}) {
  const what =
    count === undefined
      ? "every app inside"
      : count === 1
        ? "the app inside"
        : `all ${count} apps inside`;
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive-wash p-3 text-sm">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <span>
        <span className="font-medium">Delete all apps</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          Stops and permanently deletes {what}, with their deployments, domains
          and env vars.
        </span>
      </span>
    </label>
  );
}
