"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** Once acknowledged, the console opens straight away on every app, forever. */
const ACK_KEY = "deplo:console-warning-ack";

// A tiny external store over the localStorage flag. Read via useSyncExternalStore
// (not setState-in-effect), which also keeps SSR honest — the server snapshot is
// `null` (undecided), so an acknowledged user never flashes the modal on
// hydration — and lets every mounted gate flip the instant it's acknowledged.
const ackListeners = new Set<() => void>();
function readAck(): boolean {
  try {
    return window.localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false; // storage blocked (private mode) → warn again
  }
}
function subscribeAck(cb: () => void): () => void {
  ackListeners.add(cb);
  return () => ackListeners.delete(cb);
}
function writeAck(): void {
  try {
    window.localStorage.setItem(ACK_KEY, "1");
  } catch {
    /* storage blocked → proceed this once, just can't remember it */
  }
  ackListeners.forEach((cb) => cb());
}

/**
 * A one-time "know what you're doing" gate in front of the container console.
 * The console is a live terminal into a running container, so the FIRST time
 * anyone opens it we hold the terminal back behind a warning modal: leaving the
 * page is the safe default; continuing mounts the console AND remembers the
 * choice in localStorage so the modal never returns. The child (the live
 * console) isn't mounted — no agent stream opens — until the user continues.
 */
export function ConsoleWarningGate({
  slug,
  children,
}: {
  slug: string;
  children: React.ReactNode;
}) {
  // null = undecided (server render / hydration). boolean once the client has
  // read localStorage.
  const acknowledged = React.useSyncExternalStore<boolean | null>(
    subscribeAck,
    readAck,
    () => null,
  );
  const router = useRouter();

  if (acknowledged) return <>{children}</>;

  // Undecided (null) → the modal stays shut and the console stays unmounted.
  // Decided-not-acknowledged (false) → the mandatory warning.
  return (
    <Dialog open={acknowledged === false}>
      <DialogContent
        hideClose
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-[var(--warning)]" />
            Open the container console?
          </DialogTitle>
          <DialogDescription>
            This is a live terminal inside your running container. Commands and
            keystrokes take effect for real — a wrong move here can break the app
            or lose data. If you&apos;re not sure what you&apos;re doing, it&apos;s
            safer to leave this page.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => router.push(`/apps/${slug}`)}>
            Leave page
          </Button>
          <Button onClick={writeAck}>I understand, open the console</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
