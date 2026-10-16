"use client";

import * as React from "react";
import { Copy, LockKeyhole, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "@/lib/nav";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableHead } from "@/components/ui/table";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  copyEnvItems,
  readableEnvItems,
  retainEnvSelection,
  runEnvBulk,
  type BulkEnvItem,
} from "@/lib/env-bulk";

const SelectionContext = React.createContext<{
  items: BulkEnvItem[];
  selected: ReadonlySet<string>;
  pending: boolean;
  toggle: (ids: string[], checked: boolean) => void;
} | null>(null);

function selectable(item: BulkEnvItem) {
  return Boolean(
    item.remove || item.makeSecret || readableEnvItems([item]).length,
  );
}

export function EnvBulkSelection({
  items,
  onRemoved,
  removeConsequence,
  children,
}: {
  items: BulkEnvItem[];
  onRemoved: (ids: string[]) => void;
  removeConsequence: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const available = items.filter(selectable);
  const scope = JSON.stringify(available.map((item) => item.id));
  const [selection, setSelection] = React.useState({
    scope,
    ids: new Set<string>(),
  });
  if (selection.scope !== scope) {
    setSelection({
      scope,
      ids: retainEnvSelection(
        selection.ids,
        available.map((item) => item.id),
      ),
    });
  }
  const selected = retainEnvSelection(
    selection.ids,
    available.map((item) => item.id),
  );
  const [pending, setPending] = React.useState(false);
  const busy = React.useRef(false);
  const [confirmation, setConfirmation] = React.useState<{
    action: "remove" | "makeSecret";
    items: BulkEnvItem[];
  } | null>(null);
  const [converted, setConverted] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const picked = available.filter((item) => selected.has(item.id));
  const removable = picked.filter((item) => item.remove);
  const convertible = picked.filter(
    (item) => item.makeSecret && !converted.has(item.id),
  );
  const readable = readableEnvItems(
    picked.filter((item) => !converted.has(item.id)),
  );

  function toggle(ids: string[], checked: boolean) {
    if (busy.current) return;
    setSelection((previous) => {
      const next = retainEnvSelection(
        previous.ids,
        available.map((item) => item.id),
      );
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return { scope, ids: next };
    });
  }

  async function execute() {
    if (!confirmation || busy.current) return { ok: true as const };
    busy.current = true;
    setPending(true);
    try {
      const result = await runEnvBulk(confirmation.items, confirmation.action);
      setConfirmation(null);
      setSelection({ scope, ids: new Set(result.failed) });
      if (confirmation.action === "remove") onRemoved(result.succeeded);
      else {
        const secretIds = new Set(
          confirmation.items
            .filter((item) => result.succeeded.includes(item.id))
            .map((item) => item.secretId ?? item.id),
        );
        setConverted(
          (previous) =>
            new Set([
              ...previous,
              ...items
                .filter((item) => secretIds.has(item.secretId ?? item.id))
                .map((item) => item.id),
            ]),
        );
      }
      if (result.succeeded.length) {
        toast.success(
          confirmation.action === "remove"
            ? `Removed ${result.succeeded.length} variables`
            : `Made ${result.succeeded.length} variables Secret`,
        );
        router.refresh();
      }
      if (result.errors.length) {
        toast.error(`${result.failed.length} failed. ${result.errors[0]}`);
      }
      return { ok: true as const };
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyEnvItems(readable));
      toast.success(`Copied ${readable.length} Plain variables`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not copy variables",
      );
    }
  }

  return (
    <SelectionContext.Provider
      value={{ items: available, selected, pending, toggle }}
    >
      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              toggle(
                available.map((item) => item.id),
                selected.size !== available.length,
              )
            }
          >
            {selected.size === available.length ? "Unselect all" : "Select all"}
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {selected.size} selected
          </span>
          {selected.size > 0 && (
            <>
              {readable.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={copy}
                >
                  <Copy className="size-4" />
                  Copy Plain ({readable.length})
                </Button>
              )}
              {convertible.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    setConfirmation({
                      action: "makeSecret",
                      items: convertible,
                    })
                  }
                >
                  <LockKeyhole className="size-4" />
                  Make Secret ({convertible.length})
                </Button>
              )}
              {removable.length > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={pending}
                  onClick={() =>
                    setConfirmation({ action: "remove", items: removable })
                  }
                >
                  <Trash2 className="size-4" />
                  Remove ({removable.length})
                </Button>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={pending}
                aria-label="Clear selection"
                onClick={() => toggle([...selected], false)}
              >
                <X className="size-4" />
              </Button>
            </>
          )}
        </div>
      )}
      {children}
      <ConfirmAction
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy.current) setConfirmation(null);
        }}
        title={
          confirmation?.action === "remove"
            ? `Remove ${confirmation.items.length} variables?`
            : `Make ${confirmation?.items.length ?? 0} variables Secret?`
        }
        description={
          confirmation?.action === "remove"
            ? "Remove the selected variables from their current scope."
            : "Convert the selected Plain variables to write-only secrets."
        }
        consequence={
          confirmation?.action === "remove"
            ? removeConsequence
            : "Values can never be read or edited again. Shared variables change for every app that receives them."
        }
        confirmLabel={
          confirmation?.action === "remove" ? "Remove" : "Make Secret"
        }
        variant={confirmation?.action === "remove" ? "destructive" : "default"}
        confirmDisabled={pending}
        onConfirm={execute}
      />
    </SelectionContext.Provider>
  );
}

function useSelection() {
  const context = React.useContext(SelectionContext);
  if (!context) throw new Error("ENV selection requires EnvBulkSelection");
  return context;
}

export function EnvSelectionHead({ ids }: { ids?: string[] }) {
  const { items, selected, pending, toggle } = useSelection();
  const visible = items.filter((item) => !ids || ids.includes(item.id));
  const count = visible.filter((item) => selected.has(item.id)).length;
  return (
    <TableHead className="w-10">
      <Checkbox
        aria-label="Select all variables"
        disabled={pending || visible.length === 0}
        checked={
          count === 0
            ? false
            : count === visible.length
              ? true
              : "indeterminate"
        }
        onCheckedChange={(checked) =>
          toggle(
            visible.map((item) => item.id),
            checked === true,
          )
        }
      />
    </TableHead>
  );
}

export function EnvSelectionCell({ id }: { id: string }) {
  const { items, selected, pending, toggle } = useSelection();
  const item = items.find((row) => row.id === id);
  return (
    <TableCell className="w-10">
      <Checkbox
        aria-label={`Select ${item?.key ?? "variable"}`}
        checked={selected.has(id)}
        disabled={pending || !item}
        onCheckedChange={(checked) => toggle([id], checked === true)}
      />
    </TableCell>
  );
}
