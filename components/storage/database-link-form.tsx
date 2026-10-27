"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { Skeleton } from "@/components/ui/skeleton";
import { ReplaceExistingConfirm } from "@/components/env/replace-existing-confirm";
import { KEY_RE } from "@/components/env/env-parse";
import { gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";
import {
  reachable,
  REACH_LABEL,
  type DatabaseReach,
} from "@/lib/databases/link";
import { cn } from "@/lib/utils";

export interface LinkTarget {
  id: string;
  name: string;
  logo: React.ReactNode;
  place: string;
  reach: DatabaseReach;
  defaultKey: string;
  // Variable names on the app that already exist, so a clash asks first.
  takenKeys: string[];
  connectedKeys?: string[];
}

export function DatabaseLinkForm({
  targets,
  noun,
  empty,
  onConnect,
  onCancel,
  bodyClassName,
}: {
  targets: LinkTarget[] | null;
  noun: "app" | "database";
  empty: React.ReactNode;
  onConnect: (id: string, key: string) => Promise<ActionResult<unknown>>;
  onCancel: () => void;
  bodyClassName?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<LinkTarget | null>(null);
  const [key, setKey] = React.useState("");
  const [clash, setClash] = React.useState<string[]>([]);
  const [pending, startTransition] = React.useTransition();
  const keyId = React.useId();

  const q = query.trim().toLowerCase();
  const shown = targets?.filter((t) => t.name.toLowerCase().includes(q));
  const trimmed = key.trim();
  const keyValid = KEY_RE.test(trimmed);

  function pick(t: LinkTarget) {
    setSelected(t);
    setKey(t.defaultKey);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !keyValid) return;
    const replaces =
      selected.takenKeys.includes(trimmed) &&
      !selected.connectedKeys?.includes(trimmed);
    if (replaces) setClash([trimmed]);
    else connect();
  }

  function connect() {
    if (!selected) return;
    startTransition(async () => {
      const res = await onConnect(selected.id, trimmed);
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <div className={cn("space-y-4 overflow-y-auto px-6 py-4", bodyClassName)}>
        {targets === null ? (
          <div className="space-y-2 py-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : targets.length === 0 ? (
          empty
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${noun}s`}
                className="h-9 pl-8"
              />
            </div>
            {shown!.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No {noun}s match “{query.trim()}”.
              </p>
            ) : (
              <div
                role="radiogroup"
                className="divide-y divide-border overflow-hidden rounded-lg border border-border"
              >
                {shown!.map((t) => (
                  <TargetRow
                    key={t.id}
                    target={t}
                    selected={selected?.id === t.id}
                    onSelect={() => pick(t)}
                  />
                ))}
              </div>
            )}
            {selected && (
              <div className="space-y-2">
                <FieldLabel
                  htmlFor={keyId}
                  info="Your app reads the connection string from this variable. Production only."
                >
                  Variable name
                </FieldLabel>
                <Input
                  id={keyId}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  spellCheck={false}
                  aria-invalid={trimmed !== "" && !keyValid}
                  className="font-mono text-sm"
                />
              </div>
            )}
          </>
        )}
      </div>
      <DialogFooter className="border-t border-border px-6 py-4">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!selected || !keyValid || pending}>
          Connect
        </Button>
      </DialogFooter>
      <ReplaceExistingConfirm
        keys={clash}
        noun="variable"
        onClose={() => setClash([])}
        onConfirm={connect}
      />
    </form>
  );
}

function TargetRow({
  target,
  selected,
  onSelect,
}: {
  target: LinkTarget;
  selected: boolean;
  onSelect: () => void;
}) {
  const ok = reachable(target.reach);
  const connected = target.connectedKeys?.length
    ? `Connected as ${target.connectedKeys.join(", ")}`
    : null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={!ok}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
        ok ? "hover:bg-surface" : "cursor-not-allowed opacity-50",
        selected && "bg-surface",
      )}
    >
      {target.logo}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {target.name}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {[
            target.place,
            target.reach === "internal" ? null : REACH_LABEL[target.reach],
            connected,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  );
}

export function connectedToast(message: string, appId: string): void {
  toast.success(message, {
    description: "It takes effect on the next deploy.",
    action: {
      label: "Redeploy",
      onClick: () =>
        void gqlAction(
          `mutation($appId: String!) { redeploy(appId: $appId) { id } }`,
          { appId },
        ).then((r) =>
          r.ok ? toast.success("Redeploy started") : toast.error(r.error),
        ),
    },
  });
}
