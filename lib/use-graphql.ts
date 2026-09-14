"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "@/lib/nav";
import { gql, GraphQLRequestError } from "./graphql-client";

// useGraphqlMutation - run a GraphQL mutation from a client component: pending flag, error string, RSC refresh.
export function useGraphqlMutation<TData = unknown>(
  query: string,
  opts: { refresh?: boolean } = { refresh: true },
) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    (variables?: Record<string, unknown>): Promise<TData | null> =>
      new Promise((resolve) => {
        setError(null);
        startTransition(async () => {
          try {
            const data = await gql<TData>(query, variables);
            if (opts.refresh !== false) router.refresh();
            resolve(data);
          } catch (e) {
            const msg =
              e instanceof GraphQLRequestError
                ? e.message
                : e instanceof Error
                  ? e.message
                  : "Something went wrong";
            setError(msg);
            resolve(null);
          }
        });
      }),
    [query, opts.refresh, router],
  );

  return { run, pending, error, setError };
}
