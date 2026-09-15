"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function UnsavedChangesGuard({
  when,
  title = "Discard unsaved changes?",
  description = "You have unsaved changes on this page. If you leave now they'll be lost.",
  confirmLabel = "Discard & leave",
  cancelLabel = "Keep editing",
}: {
  when: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);

  React.useEffect(() => {
    if (!when) return;
    const onClick = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const anchor = (e.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      if (
        /^[a-z]+:/i.test(href) ||
        href.startsWith("//") ||
        href.startsWith("#")
      ) {
        return;
      }
      if (href === window.location.pathname + window.location.search) return;
      // Capture phase + stopPropagation runs before Next's delegated Link handler.
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [when]);

  return (
    <Dialog
      open={pendingHref !== null}
      onOpenChange={(o) => !o && setPendingHref(null)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPendingHref(null)}>
            {cancelLabel}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const href = pendingHref;
              setPendingHref(null);
              if (href) router.push(href);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
