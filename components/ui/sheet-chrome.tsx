"use client";

import { Button } from "@/components/ui/button";

// The pill a bottom sheet is dragged by, below md only.
export function SheetHandle() {
  return (
    <div
      aria-hidden
      className="absolute inset-x-0 top-0 h-[30px] touch-none md:hidden"
    >
      <span className="mx-auto mt-2.5 block h-1 w-9 rounded-full bg-ring" />
    </div>
  );
}

export function DiscardPrompt({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Discard changes?"
      className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-3 rounded-t-3xl border-t border-border bg-card px-6 pt-6 pb-[calc(env(safe-area-inset-bottom)+24px)] md:hidden"
    >
      <p className="text-lg font-semibold">Discard changes?</p>
      <p className="text-sm text-muted-foreground">
        What you typed here{" "}
        <strong className="font-medium text-foreground">will be lost</strong>.
      </p>
      <div className="mt-1 flex justify-between gap-3">
        <Button variant="outline" onClick={onKeep}>
          Keep editing
        </Button>
        <Button variant="destructive" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}
