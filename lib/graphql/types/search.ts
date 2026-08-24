import { builder } from "../builder";
import { AppStatusEnum, DatabaseTypeEnum } from "./enums";
import { DatabaseStatusEnum } from "./database";
import {
  search,
  type SearchApp,
  type SearchDatabase,
  type SearchResults,
  type SearchTeam,
} from "@/lib/data/search";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const SearchTeamRef = builder.objectRef<SearchTeam>("SearchTeam").implement({
  description: "The team a search hit was found in.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
  }),
});

const SearchAppRef = builder.objectRef<SearchApp>("SearchApp").implement({
  description:
    "An app a search matched. Deliberately small: enough to recognise it and " +
    "to read it in full with `app(slug:)` afterwards.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
    status: t.field({ type: AppStatusEnum, resolve: (a) => a.status }),
    productionUrl: t.exposeString("productionUrl", { nullable: true }),
    team: t.field({ type: SearchTeamRef, resolve: (a) => a.team }),
  }),
});

const SearchDatabaseRef = builder
  .objectRef<SearchDatabase>("SearchDatabase")
  .implement({
    description: "A database a search matched.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      type: t.field({ type: DatabaseTypeEnum, resolve: (d) => d.type }),
      status: t.field({ type: DatabaseStatusEnum, resolve: (d) => d.status }),
      team: t.field({ type: SearchTeamRef, resolve: (d) => d.team }),
    }),
  });

const SearchResultsRef = builder
  .objectRef<SearchResults>("SearchResults")
  .implement({
    description: "What a search found, grouped by kind. At most 50 of each.",
    fields: (t) => ({
      apps: t.field({ type: [SearchAppRef], resolve: (r) => r.apps }),
      databases: t.field({
        type: [SearchDatabaseRef],
        resolve: (r) => r.databases,
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Query                                                               */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  search: t.field({
    type: SearchResultsRef,
    authScopes: { loggedIn: true },
    description:
      "Find apps and databases by name, slug or id across EVERY team the " +
      "caller can reach - the one read in deplo that is not scoped to the " +
      "active team. Each hit says which team it is in. Separators and case are " +
      'ignored, so "better auth" finds `better-auth-docs`. Teams the caller ' +
      "cannot enter right now (an unmet two-factor policy, a narrowed token) " +
      "contribute nothing rather than failing the search.",
    args: {
      q: t.arg.string({
        required: true,
        description: "Part of a name, slug or id. Blank finds nothing.",
      }),
    },
    resolve: (_r, { q }) => search(q),
  }),
}));
