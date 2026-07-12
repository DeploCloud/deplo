import { builder } from "../builder";
import { EnvTargetEnum } from "./enums";
import { EnvVarTypeEnum } from "./env";
import {
  listInstanceEnv,
  upsertInstanceEnv,
  deleteInstanceEnv,
  revealInstanceEnv,
} from "@/lib/data/global-env";
import type { GlobalEnvVarDTO } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Object + input types                                                */
/* ------------------------------------------------------------------ */

const GlobalEnvVarRef = builder
  .objectRef<GlobalEnvVarDTO>("GlobalEnvVar")
  .implement({
    description:
      "An instance-wide global environment variable. Secret values are masked unless revealed.",
    fields: (t) => ({
      id: t.exposeID("id"),
      key: t.exposeString("key"),
      value: t.exposeString("value"),
      isMasked: t.exposeBoolean("masked"),
      targets: t.field({ type: [EnvTargetEnum], resolve: (e) => e.targets }),
      type: t.field({ type: EnvVarTypeEnum, resolve: (e) => e.type }),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

const UpsertGlobalEnvInputType = builder.inputType("UpsertGlobalEnvInput", {
  fields: (t) => ({
    key: t.string({ required: true }),
    value: t.string({ required: true }),
    targets: t.field({ type: [EnvTargetEnum], required: true }),
    type: t.field({ type: EnvVarTypeEnum, required: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  instanceEnv: t.field({
    type: [GlobalEnvVarRef],
    authScopes: { instanceAdmin: true },
    description:
      "Instance-wide env vars — injected into every app of every team. Instance admin only.",
    resolve: () => listInstanceEnv(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  upsertInstanceEnv: t.field({
    type: GlobalEnvVarRef,
    authScopes: { instanceAdmin: true },
    description:
      "Create or update an instance-wide variable (every team). Instance admin only.",
    args: { input: t.arg({ type: UpsertGlobalEnvInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await upsertInstanceEnv({
        key: input.key,
        value: input.value,
        targets: input.targets,
        type: input.type,
      });
      return reload(listInstanceEnv, input.key);
    },
  }),
  deleteInstanceEnv: t.field({
    type: "Boolean",
    authScopes: { instanceAdmin: true },
    description: "Delete an instance-wide variable. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteInstanceEnv(id);
      return true;
    },
  }),
  revealInstanceEnv: t.field({
    type: "String",
    authScopes: { instanceAdmin: true },
    description: "Reveal an instance-wide secret's plaintext value.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => revealInstanceEnv(id),
  }),
}));

/** Reload one var after the void upsert so the mutation can return the entity. */
async function reload(
  list: () => Promise<GlobalEnvVarDTO[]>,
  key: string,
): Promise<GlobalEnvVarDTO> {
  const found = (await list()).find((e) => e.key === key.trim());
  if (!found) throw new Error("Variable not found");
  return found;
}
