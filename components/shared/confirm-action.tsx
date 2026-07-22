"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/result";
import { cn } from "@/lib/utils";

export function ConfirmAction({
  trigger,
  open: controlledOpen,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  variant = "destructive",
  successMessage,
  confirmText,
  confirmDisabled = false,
  extra,
  onConfirm,
}: {
  /** Uncontrolled: render a trigger that opens the dialog. */
  trigger?: React.ReactNode;
  /** Controlled mode (e.g. opened from a dropdown item). */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  variant?: "destructive" | "default";
  successMessage?: string;
  /**
   * Typed confirmation: when set, the confirm button stays disabled until the
   * user types this exact string (case-sensitive). Used for irreversible,
   * in-place actions — restore (overwrites the live target) and
   * delete-with-artifacts — so the operator can't fire one with a stray click.
   * The phrase to type is surfaced for the operator; pass the target's slug/name.
   */
  confirmText?: string;
  /**
   * Hold the confirm button closed for a reason the CALLER knows: the dialog is
   * still loading what it is about to destroy, or the action is refused outright
   * and the description already says why. Independent of `confirmText` (which
   * gates on the operator's typing) and of `pending` (which gates on the action
   * already running).
   */
  confirmDisabled?: boolean;
  /**
   * Extra content rendered between the description and the footer — e.g. a
   * "also delete S3 artifacts" checkbox on a delete dialog. Keep it controlled
   * by the caller; this component only lays it out.
   */
  extra?: React.ReactNode;
  onConfirm: () => Promise<ActionResult<unknown>>;
}) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const [pending, startTransition] = React.useTransition();
  const [typed, setTyped] = React.useState("");

  // Reset the typed phrase on close so a previous attempt never leaves a stale,
  // already-matching value behind the next time the dialog opens. `onOpenChange`
  // is notified in BOTH modes (even uncontrolled), so a wrapper like
  // DeleteWithArtifacts can reset its own state on close regardless of who owns
  // the open flag.
  const setOpen = (v: boolean) => {
    if (!v) setTyped("");
    onOpenChange?.(v);
    if (!isControlled) setInternalOpen(v);
  };

  const typedOk = !confirmText || typed === confirmText;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // This dialog is routinely rendered INSIDE another dialog's <form> (a row's
    // delete action, the `extra` slot). Radix portals it out of that form in the
    // DOM, but React still bubbles the submit up the React tree — so without
    // this the outer form would silently submit too.
    e.stopPropagation();
    handleConfirm();
  }

  function handleConfirm() {
    if (!typedOk || confirmDisabled) return;
    startTransition(async () => {
      const res = await onConfirm();
      if (res.ok) {
        if (successMessage) toast.success(successMessage);
        setOpen(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          {extra}
          {confirmText && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                Type{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                  {confirmText}
                </code>{" "}
                to confirm
              </Label>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={variant}
              disabled={pending || !typedOk || confirmDisabled}
              aria-busy={pending}
              aria-label={pending ? confirmLabel : undefined}
            >
              {/* While the action runs, a spinner stands in for the label. The
                  label stays mounted (just hidden) so the button keeps its
                  width and the footer doesn't jump mid-action. */}
              <span className="grid place-items-center">
                <span
                  className={cn("col-start-1 row-start-1", pending && "invisible")}
                >
                  {confirmLabel}
                </span>
                {pending && (
                  <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                )}
              </span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
