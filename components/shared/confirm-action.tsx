"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
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
import { CopyButton } from "@/components/shared/copy-button";
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
  consequence,
  successMessage,
  confirmText,
  confirmDisabled = false,
  optimistic = false,
  extra,
  onConfirm,
}: {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  variant?: "destructive" | "default";
  consequence?: React.ReactNode;
  successMessage?: string;
  confirmText?: string;
  confirmDisabled?: boolean;
  optimistic?: boolean;
  extra?: React.ReactNode;
  onConfirm: () => Promise<ActionResult<unknown>>;
}) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const [pending, startTransition] = React.useTransition();
  const [typed, setTyped] = React.useState("");
  const confirmInputId = React.useId();

  const setOpen = (v: boolean) => {
    if (!v) setTyped("");
    onOpenChange?.(v);
    if (!isControlled) setInternalOpen(v);
  };

  const typedOk = !confirmText || typed === confirmText;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Routinely rendered INSIDE another dialog's <form> (a row's delete action, the `extra` slot).
    e.stopPropagation();
    handleConfirm();
  }

  function handleConfirm() {
    if (!typedOk || confirmDisabled) return;
    if (optimistic) {
      setOpen(false);
      void onConfirm()
        .then((res) => {
          if (res.ok) {
            if (successMessage) toast.success(successMessage);
          } else {
            toast.error(res.error);
          }
        })
        .catch((e: unknown) => toast.error((e as Error).message));
      return;
    }
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
          {consequence && <ConsequenceNote>{consequence}</ConsequenceNote>}
          {extra}
          {confirmText && (
            <div className="space-y-2">
              {/* Copy sits on the name: the next move is pasting it into the box below. */}
              <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                <Label
                  htmlFor={confirmInputId}
                  className="inline-flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground"
                >
                  Type
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all text-foreground">
                    {confirmText}
                  </code>
                </Label>
                <CopyButton value={confirmText} className="size-6" />
                <Label
                  htmlFor={confirmInputId}
                  className="text-xs text-muted-foreground"
                >
                  to confirm
                </Label>
              </div>
              <Input
                id={confirmInputId}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={variant}
              disabled={pending || !typedOk || confirmDisabled}
              aria-busy={pending}
              aria-label={pending ? confirmLabel : undefined}
            >
              {/* The label stays mounted while pending, so the button keeps its width. */}
              <span className="grid place-items-center">
                <span
                  className={cn(
                    "col-start-1 row-start-1",
                    pending && "invisible",
                  )}
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

// ConsequenceNote - what a destructive action costs, in one concrete sentence.
export function ConsequenceNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive-wash p-3 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
