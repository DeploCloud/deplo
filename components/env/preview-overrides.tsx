"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
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
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { TimeAgo } from "@/components/shared/time-ago";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

export interface PreviewOverride {
  key: string;
  type: string;
  updatedAt: string;
}

export function PreviewOverrides({
  appId,
  overrides,
}: {
  appId: string;
  overrides: PreviewOverride[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(overrides.length > 0);
  const {
    visible: visibleOverrides,
    remove: hideOverride,
    restore: restoreOverride,
  } = useOptimisticRemove(overrides, (o) => o.key);
  const [pending, startTransition] = React.useTransition();
  const [addOpen, setAddOpen] = React.useState(false);
  const [rows, setRows] = React.useState<EnvRow[]>([{ key: "", value: "" }]);
  const [secret, setSecret] = React.useState(false);

  const filled = filledRows(rows);
  const invalid = invalidRows(rows);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const typed = { rows, secret };
    setAddOpen(false);
    setRows([{ key: "", value: "" }]);
    setSecret(false);
    startTransition(async () => {
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
        setRows(typed.rows);
        setSecret(typed.secret);
        setAddOpen(true);
        toast.error(failed[0].ok ? "Could not save" : failed[0].error);
      }
    });
  }

  function remove(k: string) {
    hideOverride(k);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($appId: ID!, $key: String!) {
          deletePreviewEnvVar(appId: $appId, key: $key)
        }`,
        { appId, key: k },
      );
      if (res.ok) toast.success("Preview override removed");
      else {
        restoreOverride(k);
        toast.error(res.error);
      }
      router.refresh();
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
      <div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="group flex items-center gap-2 text-left"
          >
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
            <h3 className="flex items-center gap-2 text-sm font-medium">
              Preview overrides
              {visibleOverrides.length > 0 && (
                <Badge variant="muted" className="text-[10px] font-normal">
                  {visibleOverrides.length}
                </Badge>
              )}
            </h3>
          </button>
          <InfoTip
            content="Replaces a variable in previews only, usually to point them at a scratch database. It outranks the app's own value and any shared one."
            docs="env.previewOverrides"
          />
        </div>
        <p className="mt-1 pl-6 text-sm text-muted-foreground">
          Values used only by pull request previews, from their next deploy.
          Production is untouched.
        </p>
      </div>

      {open &&
        (visibleOverrides.length === 0 ? (
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
                    <TableHead className="text-right whitespace-nowrap">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleOverrides.map((o) => (
                    <TableRow key={o.key}>
                      <TableCell className="font-mono text-xs font-medium">
                        <div className="flex items-center gap-2">
                          {o.key}
                          <Badge
                            variant="muted"
                            className="gap-1 text-[10px] font-normal whitespace-nowrap"
                          >
                            <GitPullRequest className="size-3" />
                            Preview
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <EnvValueCell value="" masked />
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        <TimeAgo at={o.updatedAt} />
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
                <p className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted-foreground">
                  <Info className="mt-px size-3.5 shrink-0" />
                  <span>
                    Pasted overrides are added as plain. Add a secret one at a
                    time - a secret cannot be edited afterwards.
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
                disabled={pending || filled.length === 0 || invalid.length > 0}
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
