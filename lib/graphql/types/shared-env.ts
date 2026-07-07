import { builder } from "../builder";
import { EnvTargetEnum } from "./enums";
import {
  listSharedEnvGroups,
  listSharedEnvGroupsForService,
  getSharedEnvBlob,
  saveSharedEnvGroup,
  setSharedEnvGroupAttachment,
  deleteSharedEnvGroup,
  type SharedEnvGroupDTO,
  type SharedEnvVarDTO,
  type ServiceSharedEnvGroupDTO,
} from "@/lib/data/shared-env";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

/** One variable inside a shared group. Secret values arrive pre-masked. */
const SharedEnvVarRef = builder
  .objectRef<SharedEnvVarDTO>("SharedEnvVar")
  .implement({
    description:
      "A single shared environment variable; secret values are masked.",
    fields: (t) => ({
      key: t.exposeString("key"),
      value: t.exposeString("value"),
      masked: t.exposeBoolean("masked"),
      type: t.exposeString("type"),
    }),
  });

/** A reusable bundle of env vars that can be attached to many services. */
const SharedEnvGroupRef = builder
  .objectRef<SharedEnvGroupDTO>("SharedEnvGroup")
  .implement({
    description:
      "A reusable group of environment variables shared across services.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      description: t.exposeString("description"),
      variables: t.field({
        type: [SharedEnvVarRef],
        resolve: (g) => g.variables,
      }),
      targets: t.field({
        type: [EnvTargetEnum],
        description: "Deploy environments this group applies to.",
        resolve: (g) => g.targets,
      }),
      serviceIds: t.exposeIDList("serviceIds"),
      services: t.field({
        type: [SharedEnvGroupServiceRef],
        description: "Services this group is attached to.",
        resolve: (g) => g.services,
      }),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

/** Lightweight project reference embedded in a shared group. */
const SharedEnvGroupServiceRef = builder
  .objectRef<SharedEnvGroupDTO["services"][number]>("SharedEnvGroupService")
  .implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
    }),
  });

/** A shared group annotated with whether it is attached to one project. */
const ServiceSharedEnvGroupRef = builder
  .objectRef<ServiceSharedEnvGroupDTO>("ServiceSharedEnvGroup")
  .implement({
    description:
      "A shared env group as seen from one project, with attachment state.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      description: t.exposeString("description"),
      keys: t.exposeStringList("keys"),
      targets: t.field({
        type: [EnvTargetEnum],
        resolve: (g) => g.targets,
      }),
      attached: t.exposeBoolean("attached"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const SaveSharedEnvGroupInputType = builder.inputType(
  "SaveSharedEnvGroupInput",
  {
    description:
      "Create (omit id) or update (provide id) a shared env group. The blob is " +
      "raw `.env` text; secret-looking keys are masked automatically.",
    fields: (t) => ({
      id: t.string({ required: false }),
      name: t.string({ required: true }),
      description: t.string({ required: true }),
      blob: t.string({ required: true }),
      serviceIds: t.idList({ required: true }),
      targets: t.field({ type: [EnvTargetEnum], required: true }),
    }),
  },
);

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  sharedEnvGroups: t.field({
    type: [SharedEnvGroupRef],
    authScopes: { capability: "manage_env" },
    description: "All shared env groups in the active team, A→Z.",
    resolve: () => listSharedEnvGroups(),
  }),
  sharedEnvGroupsForService: t.field({
    type: [ServiceSharedEnvGroupRef],
    authScopes: { capability: "manage_env" },
    description:
      "Shared env groups annotated with whether they attach to one project.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: (_r, { serviceId }) => listSharedEnvGroupsForService(serviceId),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every shared-env server action)                          */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  saveSharedEnvGroup: t.field({
    type: SharedEnvGroupRef,
    authScopes: { capability: "manage_env" },
    description: "Create or update a shared env group; returns the saved group.",
    args: { input: t.arg({ type: SaveSharedEnvGroupInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await saveSharedEnvGroup({
        id: input.id ?? undefined,
        name: input.name,
        description: input.description,
        blob: input.blob,
        serviceIds: input.serviceIds,
        targets: input.targets,
      });
      // The data fn returns void; reload the group by name (ids are server-side
      // on create) so we can hand back the saved entity.
      return reloadSharedEnvGroup({ id: input.id ?? null, name: input.name });
    },
  }),
  setSharedEnvGroupAttachment: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description: "Attach or detach a shared group to one project. Returns true.",
    args: {
      groupId: t.arg.string({ required: true }),
      serviceId: t.arg.string({ required: true }),
      attached: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { groupId, serviceId, attached }) => {
      await setSharedEnvGroupAttachment(groupId, serviceId, attached);
      return true;
    },
  }),
  deleteSharedEnvGroup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_env" },
    description: "Delete a shared env group. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteSharedEnvGroup(id);
      return true;
    },
  }),
  revealSharedEnvBlob: t.field({
    type: "String",
    authScopes: { capability: "manage_env" },
    description:
      "Reveal the decrypted `.env` text for one shared group (prefills edits).",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getSharedEnvBlob(id),
  }),
}));

/**
 * Reload a shared env group after a void save so we can return the entity. On
 * update we match by id; on create the id is minted server-side, so match the
 * most recently-updated group with the saved name.
 */
async function reloadSharedEnvGroup(saved: {
  id: string | null;
  name: string;
}): Promise<SharedEnvGroupDTO> {
  const all = await listSharedEnvGroups();
  if (saved.id) {
    const byId = all.find((g) => g.id === saved.id);
    if (byId) return byId;
  }
  const trimmed = saved.name.trim();
  const matches = all
    .filter((g) => g.name === trimmed)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!matches[0]) throw new Error("Shared env group not found");
  return matches[0];
}
