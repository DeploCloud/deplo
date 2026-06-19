import { builder } from "../builder";
import {
  listTokens,
  createToken,
  revokeToken,
  type ApiTokenDTO,
} from "@/lib/data/tokens";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const ApiTokenRef = builder
  .objectRef<ApiTokenDTO>("ApiToken")
  .implement({
    description:
      "A team API token. Only the prefix is ever exposed — the raw token " +
      "is shown once at creation and only its hash is persisted.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      // The visible prefix (`deplo_…`) used to recognise a token in a list;
      // the full secret / tokenHash are never exposed.
      prefix: t.exposeString("prefix"),
      lastUsedAt: t.exposeString("lastUsedAt", { nullable: true }),
      createdAt: t.exposeString("createdAt"),
    }),
  });

/**
 * The payload of `createToken`: the raw secret (shown exactly once) plus the
 * persisted token record. Mirrors the data layer's `{ raw, token }` shape.
 */
const CreateTokenPayloadRef = builder
  .objectRef<{ raw: string; token: ApiTokenDTO }>("CreateTokenPayload")
  .implement({
    description:
      "Result of creating a token. `raw` is the full secret and is returned " +
      "only here, once — store it now, it cannot be recovered later.",
    fields: (t) => ({
      raw: t.exposeString("raw", {
        description: "The full token secret. Shown once and never again.",
      }),
      token: t.field({ type: ApiTokenRef, resolve: (p) => p.token }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  apiTokens: t.field({
    type: [ApiTokenRef],
    authScopes: { loggedIn: true },
    description: "All API tokens in the active team.",
    resolve: () => listTokens(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every token server action)                               */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createToken: t.field({
    type: CreateTokenPayloadRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Create a new API token. The raw secret is returned once in the payload.",
    args: { name: t.arg.string({ required: true }) },
    resolve: (_r, { name }) => createToken(name),
  }),
  revokeToken: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Revoke (delete) an API token. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await revokeToken(id);
      return true;
    },
  }),
}));
