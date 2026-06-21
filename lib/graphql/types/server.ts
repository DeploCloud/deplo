import { builder } from "../builder";
import {
  listServers,
  getServer,
  getPrimaryServer,
  addServer,
  reissueBootstrap,
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
    // Part B: provisioning/trust state, all nullable (absent on localhost or a
    // not-yet-provisioned remote). Never expose secret-shaped material — only
    // the agent VERSION + a "is it provisioned" signal + the heartbeat cache.
    provisioned: t.boolean({
      description: "True once a remote agent has called home and been trusted.",
      resolve: (s) => Boolean(s.agent?.certFingerprint),
    }),
    agentPort: t.int({
      nullable: true,
      resolve: (s) => s.agent?.port ?? null,
    }),
    agentVersion: t.string({
      nullable: true,
      resolve: (s) => s.agent?.version || null,
    }),
    lastSeenAt: t.string({
      nullable: true,
      description: "Heartbeat cache (P5) — a hint, not the source of truth.",
      resolve: (s) => s.lastSeenAt ?? null,
    }),
  }),
});

/**
 * The result of registering a remote server: the new row PLUS the one-time
 * install command the operator pastes on the box (P1). The command embeds a
 * single-use bootstrap token, so it is returned ONCE here and never re-readable
 * (the control plane stores only its hash). Re-mint with `reissueBootstrap`.
 */
interface AddServerPayload {
  server: Server;
  installCommand: string;
}

const AddServerPayloadRef = builder
  .objectRef<AddServerPayload>("AddServerPayload")
  .implement({
    description: "A newly registered server + its one-time agent install command.",
    fields: (t) => ({
      server: t.field({ type: ServerRef, resolve: (p) => p.server }),
      installCommand: t.exposeString("installCommand", {
        description:
          "Paste-on-the-server command to provision the agent. Shown once; embeds a single-use token.",
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const AddServerInputType = builder.inputType("AddServerInput", {
  description:
    "Register a remote server. Provisioned by a call-home bootstrap (no SSH-in): you run the returned install command on the box.",
  fields: (t) => ({
    name: t.string({ required: true }),
    host: t.string({ required: true }),
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
    type: AddServerPayloadRef,
    authScopes: { capability: "manage_infra" },
    args: { input: t.arg({ type: AddServerInputType, required: true }) },
    resolve: (_r, { input }) =>
      addServer({ name: input.name, host: input.host }),
  }),
  reissueServerBootstrap: t.field({
    type: AddServerPayloadRef,
    authScopes: { capability: "manage_infra" },
    description:
      "Mint a fresh install command for a server still provisioning (the original token expired or was lost).",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => reissueBootstrap(id),
  }),
  removeServer: t.field({
    type: "String",
    nullable: true,
    authScopes: { capability: "manage_infra" },
    description:
      "Disconnect and remove a remote server (revokes trust, best-effort teardown). Returns a warning string if the agent was unreachable, else null.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      const { warning } = await removeServer(id);
      return warning;
    },
  }),
}));
