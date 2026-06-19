import { builder } from "../builder";
import {
  listServers,
  getServer,
  getPrimaryServer,
  addServer,
  removeServer,
} from "@/lib/data/servers";
import type { Server } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Local enums                                                         */
/* ------------------------------------------------------------------ */

// These two unions back the Server DTO but are not shared across modules,
// so they live locally here rather than in enums.ts (exported nothing).
const ServerStatusEnum = builder.enumType("ServerStatus", {
  values: ["online", "offline", "provisioning", "error"] as const,
});

const ServerTypeEnum = builder.enumType("ServerType", {
  values: ["localhost", "remote"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const ServerRef = builder.objectRef<Server>("Server").implement({
  description: "A host (the master or a connected remote) running deployments.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    host: t.exposeString("host"),
    type: t.field({ type: ServerTypeEnum, resolve: (s) => s.type }),
    status: t.field({ type: ServerStatusEnum, resolve: (s) => s.status }),
    ip: t.exposeString("ip"),
    dockerVersion: t.exposeString("dockerVersion"),
    traefikEnabled: t.exposeBoolean("traefikEnabled"),
    cpuCores: t.exposeInt("cpuCores"),
    memoryMb: t.exposeInt("memoryMb"),
    diskGb: t.exposeInt("diskGb"),
    // Live-ish metrics, 0-100.
    cpuUsage: t.exposeInt("cpuUsage"),
    memoryUsage: t.exposeInt("memoryUsage"),
    diskUsage: t.exposeInt("diskUsage"),
    createdAt: t.exposeString("createdAt"),
  }),
});

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const AddServerInputType = builder.inputType("AddServerInput", {
  description: "Register a remote server (provisioned via SSH).",
  fields: (t) => ({
    name: t.string({ required: true }),
    host: t.string({ required: true }),
    sshPort: t.int({ required: false }),
    sshUser: t.string({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  servers: t.field({
    type: [ServerRef],
    authScopes: { loggedIn: true },
    description: "All servers, master first then remotes by creation order.",
    resolve: () => listServers(),
  }),
  server: t.field({
    type: ServerRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getServer(id),
  }),
  primaryServer: t.field({
    type: ServerRef,
    authScopes: { loggedIn: true },
    description: "The master (localhost) server, or the first one available.",
    resolve: () => getPrimaryServer(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every server action)                                     */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  addServer: t.field({
    type: ServerRef,
    authScopes: { capability: "manage_infra" },
    args: { input: t.arg({ type: AddServerInputType, required: true }) },
    resolve: (_r, { input }) =>
      addServer({
        name: input.name,
        host: input.host,
        sshPort: input.sshPort ?? undefined,
        sshUser: input.sshUser ?? undefined,
      }),
  }),
  removeServer: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Disconnect and remove a remote server. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await removeServer(id);
      return true;
    },
  }),
}));
