"use client";

import * as React from "react";
import { BookOpen } from "lucide-react";

import { ThemeToggle } from "@/components/layout/theme-toggle";
import { DeploLogo } from "@/components/logo";
import { DiscordIcon, GitHubIcon } from "@/components/shared/brand-icons";
import { docsUrl } from "@/lib/docs";
import { DISCORD_URL, GITHUB_URL } from "@/lib/links";
import { cn } from "@/lib/utils";

/** The mark holds the screen for this long before it dissolves into step one. */
const INTRO_HOLD_MS = 1500;
const INTRO_OUT_MS = 550;

export type IntroPhase = "boot" | "intro" | "intro-out" | "steps";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function alreadyPlayed(key: string | undefined): boolean {
  if (!key) return false;
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * The opening logo. `once` is a sessionStorage key that suppresses a replay;
 * without one the intro plays on every load.
 */
export function useLogoIntro(once?: string) {
  // "boot" renders nothing: deciding on the client is the only way to know
  // whether the intro is owed, and either guess would flash the other screen.
  const [phase, setPhase] = React.useState<IntroPhase>("boot");

  React.useEffect(() => {
    const play = !alreadyPlayed(once) && !prefersReducedMotion();
    // Every phase is scheduled rather than set inline, the first one included:
    // the first paint has to stay blank until the client knows what is owed.
    const at = (ms: number, next: IntroPhase) =>
      setTimeout(() => setPhase(next), ms);
    const timers = play
      ? [
          at(0, "intro"),
          at(INTRO_HOLD_MS, "intro-out"),
          at(INTRO_HOLD_MS + INTRO_OUT_MS, "steps"),
        ]
      : [at(0, "steps")];
    return () => timers.forEach(clearTimeout);
  }, [once]);

  const markSeen = React.useCallback(() => {
    if (!once) return;
    try {
      window.sessionStorage.setItem(once, "1");
    } catch {}
  }, [once]);

  return { phase, markSeen };
}

/** The mark and its aurora, drifting over whatever the page is about to show. */
export function LogoIntro({ phase }: { phase: IntroPhase }) {
  if (phase === "boot" || phase === "steps") return null;
  const leaving = phase === "intro-out";
  return (
    <>
      <div
        className={cn(
          "deplo-aurora pointer-events-none fixed inset-x-0 bottom-0 z-10 h-[55vh] overflow-hidden",
          leaving ? "animate-aurora-out" : "animate-aurora-in",
        )}
      >
        <span className="deplo-blob" />
        <span className="deplo-blob" />
        <span className="deplo-blob" />
      </div>
      <div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center">
        <DeploLogo
          className={cn(
            "text-4xl sm:text-5xl",
            leaving ? "animate-intro-out" : "animate-intro-in",
          )}
        />
      </div>
    </>
  );
}

const LINKS = [
  { href: docsUrl("docs.home"), Icon: BookOpen, label: "Documentation" },
  { href: GITHUB_URL, Icon: GitHubIcon, label: "GitHub" },
  { href: DISCORD_URL, Icon: DiscordIcon, label: "Discord" },
];

/** The furniture every auth screen carries: theme, then the three links. */
export function AuthChrome({ hidden = false }: { hidden?: boolean }) {
  if (hidden) return null;
  return (
    <>
      <div className="animate-blur-in fixed top-4 right-4 z-30">
        <ThemeToggle />
      </div>
      <div className="animate-blur-in fixed inset-x-0 bottom-4 z-30 flex items-center justify-center gap-3 text-xs text-muted-foreground">
        {LINKS.map(({ href, Icon, label }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={label}
            aria-label={label}
            className="transition-colors hover:text-foreground"
          >
            <Icon className="size-4" />
          </a>
        ))}
      </div>
    </>
  );
}
