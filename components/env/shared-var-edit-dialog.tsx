"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Share2, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import { SharedWithChips } from "@/components/env/shared-with-chips";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { SharedVarDTO } from "@/lib/data/shared-vars";

/** Mirrors the server's key rule (lib/data/shared-vars.ts) so a bad key fails here. */
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/**
 * Edit ONE shared variable's value, not who gets it. `targets` is omitted for the
 * same reason: an edit must never widen the deploy runtimes a legacy variable
 * reaches.
 */
export function SharedVarEditDialog(props: SharedVarEditDialogProps) {
  // A secret has no edit form.
  if (props.editing.type === "secret") return null;
  return <SharedVarEditForm {...props} />;
}

interface SharedVarEditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SharedVarDTO;
  /** Hand this variable to the wizard to change WHO gets it. */
  onChangeSharing?: () => void;
  /**
   * Opened from a single app's table, where the variable is one row among the
   * app's own - surface that this edit is NOT local (it lands on every app the
   * variable reaches).
   */
  warnShared?: boolean;
}

function SharedVarEditForm({
  open,
  onOpenChange,
  editing,
  onChangeSharing,
  warnShared = false,
}: SharedVarEditDialogProps) {
  // Prefill: a plain var shows its value.
  const [key, setKey] = React.useState(editing.key);
  const [value, setValue] = React.useState(editing.value);
  const [secret, setSecret] = React.useState(editing.type === "secret");
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  const trimmedKey = key.trim();
  const keyValid = KEY_RE.test(trimmedKey);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    // Closes on the click; a refusal reopens it with what was typed still in
    // the fields (the dialog is not unmounted while its save is in flight).
    onOpenChange(false);
    startTransition(async () => {
      const res = await gqlAction<{ saveSharedVar: { id: string } }>(
        `mutation($input: SaveSharedVarInput!) { saveSharedVar(input: $input) { id } }`,
        {
          input: {
            id: editing.id,
            key: trimmedKey,
            value,
            type: secret ? "secret" : "plain",
            teamIds: editing.teamIds,
            environmentIds: editing.environmentIds,
            projectIds: editing.projectIds,
            // `appIds` is deliberately ABSENT - see the doc comment above.
          },
        },
      );
      if (res.ok) {
        toast.success("Shared variable updated");
      } else {
        onOpenChange(true);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit shared variable</DialogTitle>
          <DialogDescription>
            Update this variable&apos;s name or value. Who receives it
            doesn&apos;t change.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            {warnShared && (
              <div className="flex gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                <p className="text-sm text-muted-foreground">
                  This is a{" "}
                  <span className="font-medium text-foreground">shared</span>{" "}
                  variable. Your changes apply to every app it reaches, not just
                  this one.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <FieldLabel
                info="The variable's name, exposed to every app it reaches. Renaming it takes effect on their next deploy."
                docs="env.shared"
              >
                Key
              </FieldLabel>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                spellCheck={false}
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
              <FieldLabel
                info={
                  editing.masked
                    ? "This value is a secret, so it is only ever shown masked. Leave the mask as it is to keep the stored value; type over it to replace it."
                    : "The value every app this variable reaches receives during builds and at runtime."
                }
                docs="env.types"
              >
                Value
              </FieldLabel>
              {/* The key is disabled, so the value is the first thing to put the
                  caret in, and it keeps the Dialog's initial focus off the info
                  button next to the Key label. */}
              <Textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Enter a new value"
                rows={3}
                autoFocus
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium">Secret</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Hide the value in the UI after saving. It can never be read
                  back.
                </p>
              </div>
              <Switch checked={secret} onCheckedChange={setSecret} />
            </div>

            {/* The scope, shown but not editable: it is what tells you this save
                leaves the variable reaching exactly what it reached before. */}
            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Shared with</p>
                {onChangeSharing && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onChangeSharing}
                    disabled={pending}
                  >
                    <Share2 className="size-4" />
                    Change sharing…
                  </Button>
                )}
              </div>
              <SharedWithChips v={editing} limit={Number.POSITIVE_INFINITY} />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
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
  );
}
