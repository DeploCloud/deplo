"use client";

import { Checkbox } from "@/components/ui/checkbox";

/**
 * The "Delete all apps" opt-in on a folder's or a project's delete dialog
 * (ConfirmAction's `extra` slot). Off by default, because the plain delete is the
 * safe one: the container goes and its apps move back one level.
 */
export function DeleteAppsOption({
  checked,
  onChange,
  count,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** How many apps are inside - omitted when the caller can't know (a mixed
   *  selection, where two nested folders would count the same app twice). */
  count?: number;
}) {
  const what =
    count === undefined
      ? "every app inside"
      : count === 1
        ? "the app inside"
        : `all ${count} apps inside`;
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
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
