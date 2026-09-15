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

const OWNED_CAP = 6;

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
