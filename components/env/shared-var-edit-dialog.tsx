"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Share2, AlertTriangle } from "lucide-react";
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
import type { SharedVarDTO } from "@/lib/data/shared-vars";

/**
 * Edit ONE shared variable's value — not who gets it. The single form both the
 * App tab and the Shared tab open on Edit; the four-step wizard is now reserved
 * for CREATING a variable and for changing its scope, which is what
 * `onChangeSharing` hands it. Editing a value used to mean walking Scope →
 * Details → Review to reach the Save button.
 *
 * The scope isn't merely left alone in the UI, it is round-tripped VERBATIM:
 * `teamWide` / `environmentIds` / `projectIds` go back exactly as they came, and
 * `appIds` is OMITTED — which `saveSharedVar` reads as "leave the per-app links
 * exactly as they are" (a set that IS sent replaces them wholesale, so sending
 * `[]` would silently unlink every app). `targets` is omitted for the same
 * reason: an edit must never widen the deploy runtimes a legacy variable reaches.
 * So a save here can only ever change the value and the type.
 */
export function SharedVarEditDialog({
  open,
  onOpenChange,
  editing,
  onChangeSharing,
  warnShared = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SharedVarDTO;
  /** Hand this variable to the wizard to change WHO gets it. */
  onChangeSharing?: () => void;
  /**
   * Opened from a single app's table, where the variable is one row among the
   * app's own — surface that this edit is NOT local (it lands on every app the
   * variable reaches). Redundant on the Shared tab, where that is already the
   * whole frame, so it defaults off.
   */
  warnShared?: boolean;
}) {
  // Prefill: a plain var shows its value; a secret shows the MASK, which the
  // server keeps as-is — so flipping only the type can't blank the stored value.
  const [value, setValue] = React.useState(editing.value);
  const [secret, setSecret] = React.useState(editing.type === "secret");
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<{ saveSharedVar: { id: string } }>(
        `mutation($input: SaveSharedVarInput!) { saveSharedVar(input: $input) { id } }`,
        {
          input: {
            id: editing.id,
            key: editing.key,
            value,
            type: secret ? "secret" : "plain",
            teamWide: editing.teamWide,
            environmentIds: editing.environmentIds,
            projectIds: editing.projectIds,
            // `appIds` is deliberately ABSENT — see the doc comment above.
          },
        },
      );
      if (res.ok) {
        toast.success("Shared variable updated");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit shared variable</DialogTitle>
          <DialogDescription>
            Update the value of this variable. Who receives it doesn&apos;t change.
          </DialogDescription>
        </DialogHeader>
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
            <FieldLabel info="The variable's name, exposed to every app it reaches. It can't be renamed once created.">
              Key
            </FieldLabel>
            <Input value={editing.key} className="font-mono text-sm" disabled />
          </div>
          <div className="space-y-2">
            <FieldLabel
              info={
                editing.masked
                  ? "This value is a secret, so it is only ever shown masked. Leave the mask as it is to keep the stored value; type over it to replace it."
                  : "The value every app this variable reaches receives at runtime."
              }
            >
              Value
            </FieldLabel>
            {/* The key is disabled, so the value is the first thing to put the
                caret in — and it keeps the Dialog's initial focus off the info
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
              <p className="text-xs text-muted-foreground">
                Hide the value in the UI after saving. It can never be read back.
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
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
