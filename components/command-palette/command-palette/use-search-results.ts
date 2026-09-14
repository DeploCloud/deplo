"use client";

import * as React from "react";

import { gql } from "@/lib/graphql-client";
import { SEARCH_QUERY } from "@/lib/command-palette/search-query";
import { toHits, type Hit, type SearchData } from "./search-hits";

// useSearchResults - the server half of the palette, debounced and split by team.
export function useSearchResults(
  query: string,
  typing: boolean,
  teamId: string,
) {
  const [result, setResult] = React.useState<{
    q: string;
    rows: Hit[];
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
        setResult({ q: query, rows: toHits(data) });
        // Without this a query that failed once kept its error row for the
        // whole session, underneath the results of a later retry.
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
  // The previous query's rows stay while the next one is in flight: swapping
  // them for skeletons on every keystroke makes the list strobe.
  const loading = typing && !answered && !failed;

  const [here, elsewhere] = React.useMemo(() => {
    const rows = typing ? (result?.rows ?? []) : [];
    return [
      rows.filter((h) => !h.team || h.team.id === teamId),
      rows.filter((h) => h.team && h.team.id !== teamId),
    ];
  }, [result, typing, teamId]);

  return { result, here, elsewhere, loading, failed };
}
