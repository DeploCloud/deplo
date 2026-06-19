import { builder } from "../builder";
import { RegistryTypeEnum } from "./enums";
import {
  listRegistries,
  addRegistry,
  deleteRegistry,
  type RegistryDTO,
} from "@/lib/data/registries";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const RegistryRef = builder
  .objectRef<RegistryDTO>("Registry")
  .implement({
    description:
      "A container-image registry credential owned by a team. The password / " +
      "access token is never exposed — only the connection metadata.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      type: t.field({ type: RegistryTypeEnum, resolve: (r) => r.type }),
      registryUrl: t.exposeString("registryUrl"),
      username: t.exposeString("username"),
      createdAt: t.exposeString("createdAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const AddRegistryInputType = builder.inputType("AddRegistryInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    type: t.field({ type: RegistryTypeEnum, required: true }),
    // Optional — the data layer defaults the host per registry type.
    registryUrl: t.string({ required: false }),
    username: t.string({ required: true }),
    password: t.string({ required: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  registries: t.field({
    type: [RegistryRef],
    authScopes: { loggedIn: true },
    description: "All registry credentials in the active team, newest first.",
    resolve: () => listRegistries(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every registry server action)                            */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  addRegistry: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Add a registry credential to the active team. Returns true.",
    args: { input: t.arg({ type: AddRegistryInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await addRegistry({
        name: input.name,
        type: input.type,
        registryUrl: input.registryUrl ?? undefined,
        username: input.username,
        password: input.password,
      });
      return true;
    },
  }),
  deleteRegistry: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Delete a registry credential. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteRegistry(id);
      return true;
    },
  }),
}));
