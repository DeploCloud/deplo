import { builder } from "../builder";
import { DeploySourceEnum } from "./enums";
import {
  getDevInfo,
  enableDev,
  disableDev,
  updateDev,
  startDevContainer,
  stopDevContainer,
  resetDevWorkspace,
  deployDevWorkspace,
  startTunnel,
  getTunnel,
  stopTunnel,
  isDevEligible,
  type DevInfo,
} from "@/lib/data/dev";
import {
  listDevSshUsers,
  createDevSshUser,
  removeDevSshUser,
} from "@/lib/data/dev-ssh";
import type { VscodeTunnelInfo } from "@/lib/deploy/dev";
import type { DevSshUserDTO } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Local enums                                                         */
/* ------------------------------------------------------------------ */

// These two unions are dev-only and not present in the shared enums.ts, so
// define them LOCALLY (per the module rules — do not edit the shared file).

const DevStatusEnum = builder.enumType("DevStatus", {
  values: ["off", "starting", "running", "stopped", "error"] as const,
});

const DevImageKindEnum = builder.enumType("DevImageKind", {
  values: ["preset", "custom"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const DevInfoRef = builder.objectRef<DevInfo>("DevInfo").implement({
  description: "A client-safe view of a service's dev config + preview URL.",
  fields: (t) => ({
    enabled: t.exposeBoolean("enabled"),
    status: t.field({ type: DevStatusEnum, resolve: (d) => d.status }),
    imageKind: t.field({ type: DevImageKindEnum, resolve: (d) => d.imageKind }),
    image: t.exposeString("image"),
    resolvedImage: t.exposeString("resolvedImage"),
    devCommand: t.exposeString("devCommand"),
    port: t.exposeInt("port"),
    previewEnabled: t.exposeBoolean("previewEnabled"),
    previewUrl: t.exposeString("previewUrl"),
    latestStartAt: t.exposeString("latestStartAt", { nullable: true }),
    eligible: t.exposeBoolean("eligible"),
  }),
});

const DevSshUserRef = builder
  .objectRef<DevSshUserDTO>("DevSshUser")
  .implement({
    description: "An SSH credential for a service's dev container.",
    fields: (t) => ({
      id: t.exposeID("id"),
      username: t.exposeString("username"),
      // Shown verbatim (the key is public); null when password-only.
      publicKey: t.exposeString("publicKey", { nullable: true }),
      // The password itself is never sent — only whether one is set.
      hasPassword: t.exposeBoolean("hasPassword"),
      createdAt: t.exposeString("createdAt"),
    }),
  });

const VscodeTunnelInfoRef = builder
  .objectRef<VscodeTunnelInfo>("VscodeTunnelInfo")
  .implement({
    description: "VS Code Remote Tunnel status for a service's dev container.",
    fields: (t) => ({
      running: t.exposeBoolean("running"),
      connected: t.exposeBoolean("connected"),
      loginUrl: t.exposeString("loginUrl", { nullable: true }),
      loginCode: t.exposeString("loginCode", { nullable: true }),
      tunnelUrl: t.exposeString("tunnelUrl", { nullable: true }),
      log: t.exposeString("log"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const UpdateDevInputType = builder.inputType("UpdateDevInput", {
  description:
    "Partial dev config patch; only the provided fields are changed.",
  fields: (t) => ({
    imageKind: t.field({ type: DevImageKindEnum, required: false }),
    image: t.string({ required: false }),
    devCommand: t.string({ required: false }),
    port: t.int({ required: false }),
    previewEnabled: t.boolean({ required: false }),
  }),
});

const AddDevSshUserInputType = builder.inputType("AddDevSshUserInput", {
  fields: (t) => ({
    serviceId: t.string({ required: true }),
    name: t.string({ required: true }),
    publicKey: t.string({ required: false }),
    password: t.string({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  devInfo: t.field({
    type: DevInfoRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description: "Dev config + computed preview URL for a service.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: (_r, { serviceId }) => getDevInfo(serviceId),
  }),
  devSshUsers: t.field({
    type: [DevSshUserRef],
    authScopes: { loggedIn: true },
    description: "SSH credentials for a service's dev container.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: (_r, { serviceId }) => listDevSshUsers(serviceId),
  }),
  devEligible: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description: "Whether dev mode is available for a given deploy source.",
    args: { source: t.arg({ type: DeploySourceEnum, required: true }) },
    resolve: (_r, { source }) => isDevEligible(source),
  }),
  tunnel: t.field({
    type: VscodeTunnelInfoRef,
    authScopes: { loggedIn: true },
    description: "Current VS Code tunnel status for a service.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: (_r, { serviceId }) => getTunnel(serviceId),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every dev / dev-ssh / tunnel server action)              */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  enableDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: async (_r, { serviceId }) => {
      await enableDev(serviceId);
      return reloadDevInfo(serviceId);
    },
  }),
  disableDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: async (_r, { serviceId }) => {
      await disableDev(serviceId);
      return reloadDevInfo(serviceId);
    },
  }),
  updateDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: {
      serviceId: t.arg.string({ required: true }),
      patch: t.arg({ type: UpdateDevInputType, required: true }),
    },
    resolve: async (_r, { serviceId, patch }) => {
      await updateDev(serviceId, {
        imageKind: patch.imageKind ?? undefined,
        image: patch.image ?? undefined,
        devCommand: patch.devCommand ?? undefined,
        port: patch.port ?? undefined,
        previewEnabled: patch.previewEnabled ?? undefined,
      });
      return reloadDevInfo(serviceId);
    },
  }),
  startDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: async (_r, { serviceId }) => {
      await startDevContainer(serviceId);
      return reloadDevInfo(serviceId);
    },
  }),
  stopDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: async (_r, { serviceId }) => {
      await stopDevContainer(serviceId);
      return reloadDevInfo(serviceId);
    },
  }),
  resetDevWorkspace: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    description:
      "DESTRUCTIVE: replace the workspace with a fresh copy of the source.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: async (_r, { serviceId }) => {
      await resetDevWorkspace(serviceId);
      return reloadDevInfo(serviceId);
    },
  }),
  deployDevWorkspace: t.field({
    type: "String",
    authScopes: { capability: "deploy" },
    description:
      "Deploy the current dev workspace files to production. Returns the deployment id.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: async (_r, { serviceId }) => {
      const dep = await deployDevWorkspace(serviceId);
      return dep.id;
    },
  }),
  addDevSshUser: t.field({
    type: DevSshUserRef,
    authScopes: { capability: "deploy" },
    args: { input: t.arg({ type: AddDevSshUserInputType, required: true }) },
    resolve: (_r, { input }) =>
      createDevSshUser({
        serviceId: input.serviceId,
        name: input.name,
        publicKey: input.publicKey ?? null,
        password: input.password ?? null,
      }),
  }),
  removeDevSshUser: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy" },
    description: "Remove a dev SSH user. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await removeDevSshUser(id);
      return true;
    },
  }),
  startTunnel: t.field({
    type: VscodeTunnelInfoRef,
    authScopes: { capability: "deploy" },
    description: "Start the VS Code tunnel and return the device-login link.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: (_r, { serviceId }) => startTunnel(serviceId),
  }),
  stopTunnel: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy" },
    description: "Stop the VS Code tunnel (dev container keeps running). Returns true.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: async (_r, { serviceId }) => {
      await stopTunnel(serviceId);
      return true;
    },
  }),
}));

/** Reload dev info by project id after a void mutation so we can return it. */
async function reloadDevInfo(serviceId: string): Promise<DevInfo> {
  const info = await getDevInfo(serviceId);
  if (!info) throw new Error("Service not found");
  return info;
}
