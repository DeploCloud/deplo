"use client";

import * as React from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Below md a toolbar with more than one filter keeps only its search in view: the filters
// open in a sheet from this button. On md+ it renders nothing and the caller shows them inline.
export function FilterSheet({
  active,
  onClear,
  children,
}: {
  active: number;
  onClear?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="shrink-0 md:hidden"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal />
        Filters
        {active > 0 && (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
            {active}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* No autofocus: a focused field would open its list and the keyboard on arrival. */}
        <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Filters</DialogTitle>
            <DialogDescription>
              {active > 0 ? (
                <>
                  <strong>
                    {active} {active === 1 ? "filter" : "filters"} on
                  </strong>
                  , the list updates as you pick.
                </>
              ) : (
                "The list updates as you pick."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 [&_[role=combobox]]:w-full [&>*]:w-full [&>*]:max-w-none [&>*]:flex-none">
            {children}
          </div>
          <DialogFooter>
            {onClear && (
              <Button
                variant="outline"
                disabled={active === 0}
                onClick={onClear}
              >
                Clear all
              </Button>
            )}
            <DialogClose asChild>
              <Button>Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
