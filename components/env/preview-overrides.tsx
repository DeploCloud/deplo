"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

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
 * Collapsed by default — nobody's first run should have to read it.
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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($appId: ID!, $key: String!, $value: String!, $secret: Boolean) {
          setPreviewEnvVar(appId: $appId, key: $key, value: $value, secret: $secret)
        }`,
        { appId, key: key.trim(), value, secret },
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

  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-fit items-center gap-2"
        >
          <ChevronDown
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
          <CardTitle className="flex items-center gap-2 text-base">
            Preview overrides
            <InfoTip content="A pull request preview inherits every variable above. An override replaces one of them in previews only — the usual reason is pointing previews at a scratch database instead of the production one. It outranks the app's own value and any shared variable." />
          </CardTitle>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          {overrides.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Previews use the variables above exactly as they are.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-[120px]">Value</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {overrides.map((o) => (
                  <TableRow key={o.key}>
                    <TableCell className="font-mono text-xs">{o.key}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {o.type === "secret" ? "Hidden" : "Set"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => remove(o.key)}
                        aria-label={`Remove the preview override ${o.key}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus className="size-4" />
                Add an override
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form className="grid gap-4" onSubmit={submit}>
                <DialogHeader>
                  <DialogTitle>Add a preview override</DialogTitle>
                  <DialogDescription>
                    This value replaces the app&apos;s own in pull request
                    previews. Production is untouched.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-1.5">
                  <FieldLabel htmlFor="override-key">Name</FieldLabel>
                  <Input
                    id="override-key"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="DATABASE_URL"
                    autoFocus
                  />
                </div>
                <div className="grid gap-1.5">
                  <FieldLabel htmlFor="override-value">Value</FieldLabel>
                  <Input
                    id="override-value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <FieldLabel
                    htmlFor="override-secret"
                    info="A secret override is masked here and is never given to a preview of a pull request from a fork."
                  >
                    Secret
                  </FieldLabel>
                  <Switch
                    id="override-secret"
                    checked={secret}
                    onCheckedChange={setSecret}
                  />
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setAddOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={pending || !key.trim()}>
                    {pending && <Loader2 className="size-4 animate-spin" />}
                    Save override
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </CardContent>
      )}
    </Card>
  );
}
