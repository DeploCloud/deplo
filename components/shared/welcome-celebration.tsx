"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, BookOpen, ShieldCheck } from "lucide-react";

import { DeploMark } from "@/components/logo";
import { ChannelMark } from "@/components/settings/channel-brand";
import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { docsUrl } from "@/lib/docs";
import { DISCORD_URL } from "@/lib/links";

const SHOW_MS = 4000;

/**
 * The end of first-run setup: the wizard lands here with `?welcome=1`, which is
 * stripped on arrival so a reload is a plain panel.
 */
export function WelcomeCelebration({ show }: { show: boolean }) {
  // Latched at mount: stripping the flag below re-renders this with `show`
  // already false, which would take the dialog away mid-celebration.
  const [armed] = React.useState(show);
  const [open, setOpen] = React.useState(show);
  const [confetti, setConfetti] = React.useState(show);

  React.useEffect(() => {
    if (!armed) return;
    // The History API, not the router: a router replace would re-render this
    // away before the burst is over.
    const url = new URL(window.location.href);
    url.searchParams.delete("welcome");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    const timer = setTimeout(() => setConfetti(false), SHOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!armed) return null;

  return (
    <>
      {confetti && <ConfettiBurst cannons count={64} className="z-[60]" />}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-linear-to-b from-success/15 to-transparent to-45% sm:max-w-lg">
          <DialogHeader className="items-center text-center">
            <span className="mb-2 flex size-16 items-center justify-center rounded-2xl bg-success/10">
              <DeploMark className="text-foreground" size={34} />
            </span>
            <DialogTitle>Your Deplo is ready.</DialogTitle>
            <DialogDescription>
              Your account and team are ready. Deploy your first app whenever
              you like.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <a
                href={DISCORD_URL}
                target="_blank"
                rel="noreferrer"
                className="flex flex-col gap-2 rounded-lg border border-border p-4 transition-colors hover:bg-accent"
              >
                <ChannelMark channel="discord" />
                <span className="flex items-center gap-1 text-sm font-medium">
                  Join our Discord
                  <ArrowUpRight className="size-3.5 text-muted-foreground" />
                </span>
                <span className="text-xs text-muted-foreground">
                  Get help and updates from the community.
                </span>
              </a>
              <Link
                href="/settings/security"
                onClick={() => setOpen(false)}
                className="flex flex-col gap-2 rounded-lg border border-border p-4 transition-colors hover:bg-accent"
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-success/15">
                  <ShieldCheck className="size-5 text-success" />
                </span>
                <span className="text-sm font-medium">Turn on 2FA</span>
                <span className="text-xs text-muted-foreground">
                  Ask for a second step when you sign in.
                </span>
              </Link>
            </div>
            <a
              href={docsUrl("docs.home")}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm transition-colors hover:bg-accent"
            >
              <BookOpen className="size-4 text-muted-foreground" />
              Read the docs
              <ArrowUpRight className="ml-auto size-4 text-muted-foreground" />
            </a>
          </div>
          <DialogFooter>
            <Button onClick={() => setOpen(false)}>Get started</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
