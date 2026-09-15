"use client";

import NextLink from "next/link";
import type { UrlObject } from "url";

import { useTeamSlug } from "@/lib/nav";
import { withTeam } from "@/lib/team-path";

export { useLinkStatus } from "next/link";

type Href = string | UrlObject;

// next/link with the active team put back on the href so every path stays flat - import from here, never next/link (eslint enforces it).
export default function Link({
  href,
  ...rest
}: Omit<React.ComponentProps<typeof NextLink>, "href"> & { href: Href }) {
  const slug = useTeamSlug();
  const teamed: Href =
    typeof href === "string"
      ? withTeam(href, slug)
      : href.pathname
        ? { ...href, pathname: withTeam(href.pathname, slug) }
        : href;
  return <NextLink href={teamed} {...rest} />;
}
