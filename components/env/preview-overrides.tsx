"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, GitPullRequest, Loader2, Plus, Trash2 } from "lucide-react";

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
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { KEY_RE } from "@/components/env/env-parse";
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
  const [key, setKey] = React.useState("");
  const [value, setValue] = React.useState("");
  const [secret, setSecret] = React.useState(false);

  const trimmedKey = key.trim();
  const keyValid = KEY_RE.test(trimmedKey);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($appId: ID!, $key: String!, $value: String!, $secret: Boolean) {
          setPreviewEnvVar(appId: $appId, key: $key, value: $value, secret: $secret)
        }`,
        { appId, key: trimmedKey, value, secret },
      );
      if (res.ok) {
        toast.success("Preview override saved");
        setAddOpen(false);
        setKey("");
        setValue("");
        setSecret(false);
        router.refresh();
      } else toast.error(res.error);
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

      {/* Deliberately the same form as Edit variable, field for field: same
          labels, same monospace key with the same rule and the same inline
          error, same 3-row value textarea, same SecretRow, same footer. Adding a
          variable and overriding one are the same act in the user's head. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add preview override</DialogTitle>
            <DialogDescription>
              This value replaces the app&apos;s own in pull request previews.
              Production is untouched.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={submit}>
            <div className="space-y-4">
              <div className="space-y-2">
                <FieldLabel info="The variable's name. It must match one of the app's variables to replace it - a name that matches nothing is simply added in previews.">
                  Key
                </FieldLabel>
                <Input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  spellCheck={false}
                  placeholder="DATABASE_URL"
                  aria-invalid={trimmedKey !== "" && !keyValid}
                  className={cn(
                    "font-mono text-sm",
                    trimmedKey !== "" &&
                      !keyValid &&
                      "border-destructive text-destructive focus-visible:ring-destructive",
                  )}
                />
                {trimmedKey !== "" && !keyValid && (
                  <p className="text-xs text-destructive">
                    Names must start with a letter or underscore and contain only
                    letters, digits and underscores.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Value</Label>
                <Textarea
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Enter a value"
                  rows={3}
                  autoFocus
                />
              </div>
              <SecretRow secret={secret} onChange={setSecret} />
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
              <Button type="submit" disabled={pending || !keyValid}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
