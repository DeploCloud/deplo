"use client";

import * as React from "react";
import NextLink from "next/link";
import type { UrlObject } from "url";

import { useTeamSlug } from "@/lib/nav";
import { withTeam } from "@/lib/team-path";

export { useLinkStatus } from "next/link";

type Href = string | UrlObject;

const INTENT_MS = 100;

// next/link with the active team put back on the href so every path stays flat - import from here, never next/link (eslint enforces it).
// Prefetch only on intent: every visible link was a render, and every router.refresh() ran them all again.
export default function Link({
  href,
  prefetch,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onTouchStart,
  ...rest
}: Omit<React.ComponentProps<typeof NextLink>, "href"> & { href: Href }) {
  const slug = useTeamSlug();
  const [intent, setIntent] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const want = (delay: number) => {
    clearTimeout(timer.current);
    if (delay === 0) setIntent(true);
    else timer.current = setTimeout(() => setIntent(true), delay);
  };
  const drop = () => {
    clearTimeout(timer.current);
    setIntent(false);
  };

  const teamed: Href =
    typeof href === "string"
      ? withTeam(href, slug)
      : href.pathname
        ? { ...href, pathname: withTeam(href.pathname, slug) }
        : href;
  return (
    <NextLink
      href={teamed}
      prefetch={prefetch ?? intent}
      onPointerEnter={(e) => {
        onPointerEnter?.(e);
        if (e.pointerType === "mouse") want(INTENT_MS);
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e);
        drop();
      }}
      onFocus={(e) => {
        onFocus?.(e);
        want(0);
      }}
      onBlur={(e) => {
        onBlur?.(e);
        drop();
      }}
      onTouchStart={(e) => {
        onTouchStart?.(e);
        want(0);
      }}
      {...rest}
    />
  );
}
