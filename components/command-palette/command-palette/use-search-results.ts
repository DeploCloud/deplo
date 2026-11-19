"use client";

import * as React from "react";

import { gql } from "@/lib/graphql-client";
import { SEARCH_QUERY } from "@/lib/command-palette/search-query";
import { toHits, type HitContext, type SearchData } from "./search-hits";

export function useSearchResults(
  query: string,
  typing: boolean,
  { teamId, canManageMembers, isAdmin }: HitContext,
) {
  const [result, setResult] = React.useState<{
    q: string;
    data: SearchData;
  } | null>(null);
  const [failedQuery, setFailedQuery] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!typing) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const data = await gql<SearchData>(
          SEARCH_QUERY,
          { q: query },
          controller.signal,
        );
        setResult({ q: query, data });
        setFailedQuery((q) => (q === query ? null : q));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setFailedQuery(query);
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, typing]);

  const answered = result?.q === query;
  const failed = failedQuery === query;
  const loading = typing && !answered && !failed;

  const [here, elsewhere] = React.useMemo(() => {
    const rows =
      typing && result
        ? toHits(result.data, { teamId, canManageMembers, isAdmin })
        : [];
    return [
      rows.filter((h) => !h.team || h.team.id === teamId),
      rows.filter((h) => h.team && h.team.id !== teamId),
    ];
  }, [result, typing, teamId, canManageMembers, isAdmin]);

  return { result, here, elsewhere, loading, failed };
}
