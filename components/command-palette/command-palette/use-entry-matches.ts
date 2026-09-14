"use client";

import * as React from "react";

import { canSee } from "@/components/layout/nav-config/nav-item";
import {
  countOwnedPages,
  matchEntries,
  matchOwnedPages,
  ownedPageEntries,
  teamPageEntries,
  staticEntries,
} from "@/lib/command-palette/entries";
import { foldQuery } from "@/lib/match-query";
import type { BreadcrumbGraph } from "@/lib/breadcrumb-model";

// How many of one resource's pages are shown before the palette offers the rest.
const OWNED_CAP = 6;

// useEntryMatches - the in-bundle half of the palette: pages, settings, commands.
export function useEntryMatches({
  query,
  teams,
  teamId,
  breadcrumb,
  capabilities,
  isAdmin,
}: {
  query: string;
  teams: { id: string; name: string; avatarUrl?: string | null }[];
  teamId: string;
  breadcrumb: BreadcrumbGraph;
  capabilities: string[];
  isAdmin: boolean;
}) {
  const caps = React.useMemo(() => new Set(capabilities), [capabilities]);

  const catalogue = React.useMemo(
    () => staticEntries().filter((e) => canSee(e, caps, isAdmin)),
    [caps, isAdmin],
  );

  const matched = React.useMemo(
    () => matchEntries(catalogue, query),
    [catalogue, query],
  );

  // Built off the breadcrumb snapshot, so no extra request, and only once
  // something has been typed, since this is a dozen rows per app.
  const typing = Boolean(foldQuery(query));
  const owned = React.useMemo(
    () =>
      typing ? ownedPageEntries(breadcrumb.apps, breadcrumb.databases) : [],
    [breadcrumb, typing],
  );
  const visibleOwned = React.useMemo(
    () => owned.filter((e) => canSee(e, caps, isAdmin)),
    [owned, caps, isAdmin],
  );
  // Reset with the query, exactly like the highlight.
  const [expandedPages, setExpandedPages] = React.useState<string | null>(null);
  const pagesExpanded = expandedPages === query;
  const ownedTotal = React.useMemo(
    () => countOwnedPages(visibleOwned, query),
    [visibleOwned, query],
  );
  const ownedMatched = React.useMemo(
    () =>
      matchOwnedPages(
        visibleOwned,
        query,
        pagesExpanded ? Number.POSITIVE_INFINITY : OWNED_CAP,
      ),
    [visibleOwned, query, pagesExpanded],
  );
  const hiddenPages = ownedTotal - ownedMatched.length;

  // `caps` is the ACTIVE team's, so a page can be filtered by a capability held
  // somewhere else - a UX approximation, like every other check here. The gate
  // that counts is `requireCapability`, in the data layer, per team.
  const otherTeamPages = React.useMemo(
    () =>
      typing
        ? matchEntries(
            teamPageEntries(teams, teamId).filter((e) =>
              canSee(e, caps, isAdmin),
            ),
            query,
          )
        : [],
    [typing, query, teams, teamId, caps, isAdmin],
  );

  return {
    typing,
    matched,
    ownedMatched,
    hiddenPages,
    otherTeamPages,
    setExpandedPages,
  };
}
