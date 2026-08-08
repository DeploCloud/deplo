"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  GitPullRequest,
  Info,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EnvValueCell } from "@/components/env/env-value-cell";
import {
  EnvRowsEditor,
  filledRows,
  invalidRows,
  type EnvRow,
} from "@/components/env/env-rows-editor";
import { SecretRow } from "@/components/env/secret-row";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";

export interface PreviewOverride {
  key: string;
  type: string;
  updatedAt: string;
}

/**
 * Preview-only variable overrides (advanced).
 *
 * A preview inherits this app's variables exactly, which is what makes previews
 * work with no configuration at all. This is the escape hatch for the one case
 * that genuinely matters: pointing previews at a scratch database instead of the
 * production one. An override outranks the app's own value AND any shared
 * variable, in previews only.
 *
 * Built to read as the SIBLING of the variables table above it, not as a
 * different product: the same section heading, the same bordered table, the same
 * key/value/modified columns and the same row actions. It stays a disclosure —
 * an app that never opens it should not have to read past an empty box — but
 * everything inside the disclosure is the neighbour's furniture.
 */
export function PreviewOverrides({
  appId,
  overrides,
}: {
  appId: string;
  overrides: PreviewOverride[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(overrides.length > 0);
  const [pending, startTransition] = React.useTransition();
  const [addOpen, setAddOpen] = React.useState(false);
  const [rows, setRows] = React.useState<EnvRow[]>([{ key: "", value: "" }]);
  const [secret, setSecret] = React.useState(false);

  const filled = filledRows(rows);
  const invalid = invalidRows(rows);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      // No bulk mutation for overrides, and none is worth adding: setPreviewEnvVar
      // is an upsert, so firing them together costs one round trip and a retry
      // after a partial failure simply rewrites what already landed.
      const results = await Promise.all(
        filled.map((r) =>
          gqlAction(
            `mutation ($appId: ID!, $key: String!, $value: String!, $secret: Boolean) {
              setPreviewEnvVar(appId: $appId, key: $key, value: $value, secret: $secret)
            }`,
            {
              appId,
              key: r.key.trim(),
              value: r.value,
              // Same rule as Add variable: the toggle only speaks for a single
              // row, and a batch lands plain to be flipped from the table.
              secret: filled.length === 1 ? secret : false,
            },
          ),
        ),
      );
      const failed = results.filter((r) => !r.ok);
      const saved = results.length - failed.length;
      if (saved > 0) {
        toast.success(
          saved === 1 ? "Preview override saved" : `Saved ${saved} overrides`,
        );
        router.refresh();
      }
      if (failed.length > 0) {
        // Keep the dialog open on the rows as typed: the ones that landed are
        // idempotent, so fixing the bad key and submitting again is safe.
        toast.error(failed[0].ok ? "Could not save" : failed[0].error);
        return;
      }
      setAddOpen(false);
      setRows([{ key: "", value: "" }]);
      setSecret(false);
    });
  }

  function remove(k: string) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($appId: ID!, $key: String!) {
          deletePreviewEnvVar(appId: $appId, key: $key)
        }`,
        { appId, key: k },
      );
      if (res.ok) {
        toast.success("Preview override removed");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  const addButton = (
    <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
      <Plus className="size-4" />
      Add override
    </Button>
  );

  return (
    <section className="space-y-4">
      {/* The heading matches "Environment Variables" above, with the chevron
          making it a disclosure rather than a second permanent section. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-start gap-2 text-left"
      >
        <ChevronDown
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            Preview overrides
            {overrides.length > 0 && (
              <Badge variant="muted" className="text-[10px] font-normal">
                {overrides.length}
              </Badge>
            )}
            <InfoTip content="A pull request preview inherits every variable above. An override replaces one of them in previews only - the usual reason is pointing previews at a scratch database instead of the production one. It outranks the app's own value and any shared variable." />
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Values used only by pull request previews. Production is untouched.
          </p>
        </div>
      </button>

      {open &&
        (overrides.length === 0 ? (
          // Not an EmptyState card: this sits INSIDE a disclosure the reader just
          // opened, and a second dashed box under the variables table would read
          // as a second empty product rather than a note.
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-3">
            <p className="text-sm text-muted-foreground">
              Previews use the variables above exactly as they are.
            </p>
            {addButton}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">Key</TableHead>
                    <TableHead className="w-full">Value</TableHead>
                    <TableHead className="whitespace-nowrap">
                      Last modified
                    </TableHead>
                    <TableHead className="whitespace-nowrap text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overrides.map((o) => (
                    <TableRow key={o.key}>
                      <TableCell className="font-mono text-xs font-medium">
                        <div className="flex items-center gap-2">
                          {o.key}
                          <Badge
                            variant="muted"
                            className="gap-1 whitespace-nowrap text-[10px] font-normal"
                          >
                            <GitPullRequest className="size-3" />
                            Preview
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        {/* Always locked: an override's value is never projected
                            back, secret or not, so there is nothing to reveal. */}
                        <EnvValueCell value="" masked />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        <SimpleTooltip
                          content={new Date(o.updatedAt).toLocaleString()}
                        >
                          <span>{timeAgo(o.updatedAt)}</span>
                        </SimpleTooltip>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-destructive"
                            disabled={pending}
                            onClick={() => remove(o.key)}
                            aria-label={`Delete the preview override ${o.key}`}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex justify-end">{addButton}</div>
          </div>
        ))}

      {/* Deliberately the same dialog as Add variable, down to the row editor
          itself: overriding one value and adding one are the same act in the
          user's head, and doing five of them a modal at a time is the kind of
          thing nobody does twice. Same `.env` paste, same "Add another", same
          rule about the secret toggle only speaking for a single row. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add preview override</DialogTitle>
            <DialogDescription>
              These values replace the app&apos;s own in pull request previews.
              Production is untouched.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={submit}>
            <div className="space-y-4">
              <EnvRowsEditor rows={rows} onChange={setRows} />

              {filled.length > 1 ? (
                <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-xs text-muted-foreground">
                  <Info className="mt-px size-3.5 shrink-0" />
                  <span>
                    Pasted overrides are added as plain - flip individual ones to
                    secret from the table.
                  </span>
                </p>
              ) : (
                <SecretRow secret={secret} onChange={setSecret} />
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  pending || filled.length === 0 || invalid.length > 0
                }
              >
                {pending && <Loader2 className="size-4 animate-spin" />}
                {filled.length > 1 ? `Save ${filled.length}` : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
