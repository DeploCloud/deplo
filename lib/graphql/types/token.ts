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
    // The scope tree, one list per level. All four empty ⇒ unrestricted: every
    // team the creator belongs to, and everything in it. A team id means that
    // WHOLE team; a project or folder id means that whole container, subfolders
    // included; an app id means just that app. Naming anything below a team
    // narrows the token inside it and drops the team-wide capabilities it was
    // given there.
    teamIds: t.stringList({ required: false }),
    projectIds: t.stringList({ required: false }),
    folderIds: t.stringList({ required: false }),
    appIds: t.stringList({ required: false }),
    instanceAdmin: t.boolean({ required: false }),
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
    authScopes: { capability: "manage_tokens" },
    description:
      "Create a new API token with its own permissions. The raw secret is " +
      "returned once in the payload.",
    args: { input: t.arg({ type: CreateTokenInputType, required: true }) },
    resolve: (_r, { input }) =>
      createToken({
        name: input.name,
        capabilities: (input.capabilities ?? undefined) as
          | Capability[]
          | undefined,
        teamIds: input.teamIds ?? undefined,
        projectIds: input.projectIds ?? undefined,
        folderIds: input.folderIds ?? undefined,
        appIds: input.appIds ?? undefined,
        instanceAdmin: input.instanceAdmin ?? undefined,
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
          | Capability[]
          | undefined,
        teamIds: input.teamIds ?? undefined,
        projectIds: input.projectIds ?? undefined,
        folderIds: input.folderIds ?? undefined,
        appIds: input.appIds ?? undefined,
        instanceAdmin: input.instanceAdmin ?? undefined,
      });
      return true;
    },
  }),
  revokeToken: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_tokens" },
    description: "Revoke (delete) an API token. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await revokeToken(id);
      return true;
    },
  }),
}));
