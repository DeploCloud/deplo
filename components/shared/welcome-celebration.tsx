"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  BookOpen,
  MessagesSquare,
  ShieldCheck,
} from "lucide-react";

import { DeploMark } from "@/components/logo";
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

const DISCORD_URL = "https://ds.deplo.build";
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="items-center text-center">
            <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10">
              <DeploMark className="text-primary" size={18} />
            </span>
            <DialogTitle>Your instance is ready</DialogTitle>
            <DialogDescription>
              Your account and team are ready. Deploy your first app whenever
              you like.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button variant="outline" className="justify-start" asChild>
              <a href={DISCORD_URL} target="_blank" rel="noreferrer">
                <MessagesSquare className="size-4" />
                Join the Discord for updates
                <ArrowUpRight className="ml-auto size-4" />
              </a>
            </Button>
            <Button variant="outline" className="justify-start" asChild>
              <a href={docsUrl("docs.home")} target="_blank" rel="noreferrer">
                <BookOpen className="size-4" />
                Read the docs
                <ArrowUpRight className="ml-auto size-4" />
              </a>
            </Button>
            <Button variant="outline" className="justify-start" asChild>
              <Link href="/settings/security" onClick={() => setOpen(false)}>
                <ShieldCheck className="size-4" />
                Turn on two-factor authentication
                <ArrowUpRight className="ml-auto size-4" />
              </Link>
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setOpen(false)}>Get started</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
