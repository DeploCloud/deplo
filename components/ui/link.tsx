"use client";

import NextLink from "next/link";
import type { UrlObject } from "url";

import { useTeamSlug } from "@/lib/nav";
import { withTeam } from "@/lib/team-path";

export { useLinkStatus } from "next/link";

type Href = string | UrlObject;

/**
 * `next/link` with the team the page is in put back on the href, so every path in
 * this codebase stays FLAT (`/apps/web`). Import it from here, never from
 * `next/link`, or the link leaves the team behind (eslint enforces it).
 */
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
