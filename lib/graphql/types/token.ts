import { builder } from "../builder";
import { CapabilityEnum } from "./enums";
import {
  listTokens,
  createToken,
  updateToken,
  revokeToken,
  type ApiTokenDTO,
} from "@/lib/data/tokens";
import type { Capability } from "@/lib/types";

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
      capabilities: t.exposeStringList("capabilities", {
        description:
          "What this token itself may do. Its effective power is this set " +
          "intersected with what its creator can still do in the team, so a " +
          "token can never outlive the access of the member who minted it.",
      }),
      scoped: t.exposeBoolean("scoped", {
        description:
          "Whether this token is limited at all. False means every team its " +
          "creator belongs to, and everything in it.",
      }),
      teamIds: t.exposeStringList("teamIds", {
        description:
          "Whole teams in the scope: every project and every app in them.",
      }),
      projectIds: t.exposeStringList("projectIds", {
        description:
          "Whole projects in the scope: every app in them, now and later. " +
          "Naming one narrows the token inside that team, so the team-wide " +
          "permissions it holds (managing members, roles, databases) stop " +
          "applying there.",
      }),
      folderIds: t.exposeStringList("folderIds", {
        description:
          "Whole folders in the scope: every app in them and in the folders " +
          "nested under them. Most apps live in a folder, so this is usually " +
          "the level a scope is drawn at.",
      }),
      appIds: t.exposeStringList("appIds", {
        description: "Individually-named apps in the scope.",
      }),
      homeTeamId: t.exposeID("homeTeamId", {
        description:
          "The team this token is MANAGED from — where it was created. Any team " +
          "it reaches can revoke it; only this one can change it.",
      }),
      homeTeamName: t.exposeString("homeTeamName", {
        description: "That team's name, for a list that spans teams.",
      }),
      instanceAdmin: t.exposeBoolean("instanceAdmin", {
        description:
          "The token may administer the whole instance — users, servers and " +
          "the global environment — not just its team. Mutually exclusive " +
          "with a project scope.",
      }),
      createdByUsername: t.exposeString("createdByUsername", {
        nullable: true,
        description: "The member this token acts as, and is clamped to.",
      }),
      createdByAvatarColor: t.exposeString("createdByAvatarColor", {
        nullable: true,
      }),
      createdByAvatarUrl: t.exposeString("createdByAvatarUrl", {
        nullable: true,
        description:
          "That member's resolved picture, so a token names them the way every other screen does.",
      }),
      oauthClientName: t.exposeString("oauthClientName", {
        nullable: true,
        description:
          "Set when this token was minted by connecting an AI client over " +
          "OAuth rather than from the tokens page. Such a token is managed " +
          "under Settings → MCP Server and is not edited by hand.",
      }),
      expiresAt: t.exposeString("expiresAt", {
        nullable: true,
        description:
          "When this token stops working. Null means never, which is what a " +
          "token minted before expiries existed still is. An expired token " +
          "resolves to nothing everywhere - the API, MCP and deploy hooks alike.",
      }),
      expired: t.exposeBoolean("expired", {
        description:
          "Whether the expiry above has passed. Answered by the server, so a " +
          "client with a wrong clock cannot disagree about whether a credential " +
          "still works.",
      }),
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
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const CreateTokenInputType = builder.inputType("CreateTokenInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    // Omitted / empty ⇒ a view-only token. `view` is added server-side either
    // way. There is no "everything" default: a token that quietly held its
    // creator's whole access is exactly what this input replaced.
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
    // The scope tree, one list per level.
    teamIds: t.stringList({ required: false }),
    projectIds: t.stringList({ required: false }),
    folderIds: t.stringList({ required: false }),
    appIds: t.stringList({ required: false }),
    instanceAdmin: t.boolean({ required: false }),
    // ISO instant. Omitted ⇒ the token never expires, which is what every
    // token was before this field existed.
    expiresAt: t.string({ required: false }),
  }),
});

const UpdateTokenInputType = builder.inputType("UpdateTokenInput", {
  fields: (t) => ({
    id: t.string({ required: true }),
    name: t.string({ required: true }),
    capabilities: t.field({ type: [CapabilityEnum], required: false }),
    teamIds: t.stringList({ required: false }),
    projectIds: t.stringList({ required: false }),
    folderIds: t.stringList({ required: false }),
    appIds: t.stringList({ required: false }),
    instanceAdmin: t.boolean({ required: false }),
    // ISO instant, or null to clear the expiry. OMITTED leaves it alone, so a
    // client that renames a token cannot silently un-expire it.
    expiresAt: t.string({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  apiTokens: t.field({
    type: [ApiTokenRef],
    authScopes: { loggedIn: true },
    description:
      "Every API token that can act in the active team. A dashboard session " +
      "also gets the ones it minted in its other teams; a bearer request stays " +
      "scoped to the team it resolved to.",
    resolve: () => listTokens(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every token server action)                               */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createToken: t.field({
    type: CreateTokenPayloadRef,
    authScopes: { capability: "manage_tokens" },
    description:
      "Create a new API token with its own permissions. The raw secret is " +
      "returned once in the payload.",
    args: { input: t.arg({ type: CreateTokenInputType, required: true }) },
    resolve: (_r, { input }) =>
      createToken({
        name: input.name,
        capabilities: (input.capabilities ?? undefined) as
          Capability[] | undefined,
        teamIds: input.teamIds ?? undefined,
        projectIds: input.projectIds ?? undefined,
        folderIds: input.folderIds ?? undefined,
        appIds: input.appIds ?? undefined,
        instanceAdmin: input.instanceAdmin ?? undefined,
        expiresAt: input.expiresAt ?? undefined,
      }),
  }),
  updateToken: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_tokens" },
    description:
      "Change a token's name, permissions or project scope. The secret is " +
      "unchanged, so tightening a live token costs no rotation. Returns true.",
    args: { input: t.arg({ type: UpdateTokenInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await updateToken({
        id: input.id,
        name: input.name,
        capabilities: (input.capabilities ?? undefined) as
          Capability[] | undefined,
        teamIds: input.teamIds ?? undefined,
        projectIds: input.projectIds ?? undefined,
        folderIds: input.folderIds ?? undefined,
        appIds: input.appIds ?? undefined,
        instanceAdmin: input.instanceAdmin ?? undefined,
        // `null` from a client CLEARS the expiry; absent leaves it.
        expiresAt: input.expiresAt,
      });
      return true;
    },
  }),
  revokeToken: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_tokens" },
    description:
      "Delete this token. The credential stops working immediately in every " +
      "team it reached, not only the active one, and an OAuth connection's " +
      "consent and refresh token go with it. Any team it can act in may revoke " +
      "it, and so may its creator. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await revokeToken(id);
      return true;
    },
  }),
}));
