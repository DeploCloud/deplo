"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Warns before leaving a page that has unsaved edits. Mount it with `when` set
 * to the page's aggregate dirty flag; it guards two navigation vectors while
 * dirty and does nothing otherwise:
 *
 *   1. Hard navigation (tab close / reload / typing a new URL) — the native
 *      `beforeunload` prompt, which browsers render themselves.
 *   2. Soft, in-app navigation (clicking a sidebar/tab `<Link>`) — a capture-
 *      phase click listener intercepts internal anchor clicks BEFORE Next's
 *      Link handler runs, then routes through our own confirm dialog so the
 *      user can keep editing or discard and continue.
 *
 * Browser Back/Forward (popstate) is intentionally NOT guarded — the App Router
 * exposes no reliable hook for it, and the two vectors above cover the paths a
 * user actually takes to leave the form.
 */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
  const router = useRouter();
  // The href a blocked click was heading to; non-null ⇒ show the confirm dialog.
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require a returnValue to trigger the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);

  React.useEffect(() => {
    if (!when) return;
    const onClick = (e: MouseEvent) => {
      // Let modified clicks (new tab/window), non-primary buttons and already-
      // handled events through untouched.
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
      // Opens in a new tab → not leaving this page.
      if (anchor.target && anchor.target !== "_self") return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // Only guard internal, same-document navigations.
      if (/^[a-z]+:/i.test(href) || href.startsWith("//") || href.startsWith("#")) {
        return;
      }
      if (href === window.location.pathname + window.location.search) return;
      // Capture phase + stopPropagation runs before Next's delegated Link
      // handler, so the navigation never starts until the user confirms.
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [when]);

  return (
    <Dialog open={pendingHref !== null} onOpenChange={(o) => !o && setPendingHref(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>
            You have unsaved changes on this page. If you leave now they&apos;ll
            be lost.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPendingHref(null)}>
            Keep editing
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const href = pendingHref;
              setPendingHref(null);
              if (href) router.push(href);
            }}
          >
            Discard &amp; leave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
