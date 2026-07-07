import { builder } from "../builder";
import { EnvVarTypeEnum } from "./env";
import {
  listEnvironmentEnv,
  upsertEnvironmentEnv,
  deleteEnvironmentEnv,
  revealEnvironmentEnv,
} from "@/lib/data/environment-env";
import type { EnvironmentEnvVarDTO } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Object + input types                                                */
/* ------------------------------------------------------------------ */

const EnvironmentEnvVarRef = builder
  .objectRef<EnvironmentEnvVarDTO>("EnvironmentEnvVar")
  .implement({
    description:
      "An environment-scoped shared variable (ADR-0008) — stored on one of a " +
      "Project's environments and injected into every service of that Project " +
      "in that environment's context. No targets axis: the environment IS the " +
      "scope. Secret values are masked unless revealed.",
    fields: (t) => ({
      id: t.exposeID("id"),
      environmentId: t.exposeID("environmentId"),
      key: t.exposeString("key"),
      value: t.exposeString("value"),
      isMasked: t.exposeBoolean("masked"),
      type: t.field({ type: EnvVarTypeEnum, resolve: (e) => e.type }),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

const UpsertEnvironmentEnvInputType = builder.inputType(
  "UpsertEnvironmentEnvInput",
  {
    fields: (t) => ({
      environmentId: t.id({ required: true }),
      key: t.string({ required: true }),
      value: t.string({ required: true }),
      type: t.field({ type: EnvVarTypeEnum, required: true }),
    }),
  },
);

/* ------------------------------------------------------------------ */
/* Query                                                               */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  environmentEnv: t.field({
    type: [EnvironmentEnvVarRef],
    authScopes: { capability: "manage_env" },
    description:
      "One environment's shared variables — injected into every service of the owning Project, in that environment's context.",
    args: { environmentId: t.arg.id({ required: true }) },
    resolve: (_r, { environmentId }) => listEnvironmentEnv(String(environmentId)),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  upsertEnvironmentEnv: t.field({
    type: EnvironmentEnvVarRef,
    authScopes: { capability: "manage_env" },
    description:
      "Create or update an environment-scoped shared variable; returns the entity.",
    args: { input: t.arg({ type: UpsertEnvironmentEnvInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await upsertEnvironmentEnv({
        environmentId: String(input.environmentId),
        key: input.key,
        value: input.value,
        type: input.type,
      });
      const found = (await listEnvironmentEnv(String(input.environmentId))).find(
        (e) => e.key === input.key.trim(),
      );
      if (!found) throw new Error("Variable not found");
      return found;
    },
  }),
  deleteEnvironmentEnv: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description: "Delete an environment-scoped shared variable. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteEnvironmentEnv(id);
      return true;
    },
  }),
  revealEnvironmentEnv: t.field({
    type: "String",
    authScopes: { capability: "manage_env" },
    description: "Reveal an environment-scoped secret's plaintext value.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => revealEnvironmentEnv(id),
  }),
}));
