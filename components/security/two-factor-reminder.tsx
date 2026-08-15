"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * A periodic nudge to turn on two-factor authentication.
 *
 * Deliberately a LOCAL preference, not a server one: this is a nag, and a nag
 * the user silenced on their laptop has no business being an account-wide
 * setting to migrate, back up, or explain. localStorage is exactly the right
 * lifetime for it.
 *
 * The one hard rule: it never appears for an account that already has a second
 * factor - an authenticator app OR a passkey (ADR-0024). The caller passes that
 * in from the server-rendered viewer, so there is no window where a compliant
 * user gets asked anyway, and somebody who set passkeys up is never told to go
 * and set up the thing they already have.
 */
const KEY = "deplo:2fa-reminder";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** `"off"` = never again; a number = epoch ms before which we stay quiet. */
function readState(): "off" | number {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === "off") return "off";
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // Storage blocked (private mode). Treat as "never remind" rather than
    // "remind on every single page load", which is what 0 would mean.
    return "off";
  }
}

function write(value: "off" | number): void {
  try {
    window.localStorage.setItem(KEY, String(value));
  } catch {
    /* storage blocked → nothing to remember, and nothing to break */
  }
}

export function TwoFactorReminder({
  hasSecondFactor,
}: {
  hasSecondFactor: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [never, setNever] = React.useState(false);

  React.useEffect(() => {
    if (hasSecondFactor) return;
    // Read in an effect, not during render: localStorage does not exist on the
    // server, and deciding during hydration would mismatch.
    const state = readState();
    if (state === "off") return;
    if (Date.now() < state) return;
    // A beat after the page settles, so the reminder does not race the content
    // the user actually navigated for.
    const t = setTimeout(() => setOpen(true), 1500);
    return () => clearTimeout(t);
  }, [hasSecondFactor]);

  if (hasSecondFactor) return null;

  function dismiss() {
    write(never ? "off" : Date.now() + SNOOZE_MS);
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) dismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="size-5 text-primary" />
          </div>
          <DialogTitle>Make this account harder to break into</DialogTitle>
          <DialogDescription>
            Two-factor authentication adds a code from your phone on top of your
            password. It takes about a minute to set up, and it means a stolen
            password is not enough to reach your apps.
          </DialogDescription>
        </DialogHeader>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={never}
            onCheckedChange={(v) => setNever(v === true)}
          />
          Do not show this again
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>
            {never ? "Close" : "Remind me later"}
          </Button>
          <Button
            onClick={() => {
              // Silence it either way: they are on their way to do the thing.
              write(never ? "off" : Date.now() + SNOOZE_MS);
              setOpen(false);
              router.push("/settings/security");
            }}
          >
            Set it up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
