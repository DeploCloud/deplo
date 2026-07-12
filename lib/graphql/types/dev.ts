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
  description: "A client-safe view of an app's dev config + preview URL.",
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
    description: "An SSH credential for an app's dev container.",
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
    description: "VS Code Remote Tunnel status for an app's dev container.",
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
    appId: t.string({ required: true }),
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
    description: "Dev config + computed preview URL for an app.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => getDevInfo(appId),
  }),
  devSshUsers: t.field({
    type: [DevSshUserRef],
    authScopes: { loggedIn: true },
    description: "SSH credentials for an app's dev container.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => listDevSshUsers(appId),
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
    description: "Current VS Code tunnel status for an app.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => getTunnel(appId),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every dev / dev-ssh / tunnel server action)              */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  enableDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      await enableDev(appId);
      return reloadDevInfo(appId);
    },
  }),
  disableDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      await disableDev(appId);
      return reloadDevInfo(appId);
    },
  }),
  updateDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: {
      appId: t.arg.string({ required: true }),
      patch: t.arg({ type: UpdateDevInputType, required: true }),
    },
    resolve: async (_r, { appId, patch }) => {
      await updateDev(appId, {
        imageKind: patch.imageKind ?? undefined,
        image: patch.image ?? undefined,
        devCommand: patch.devCommand ?? undefined,
        port: patch.port ?? undefined,
        previewEnabled: patch.previewEnabled ?? undefined,
      });
      return reloadDevInfo(appId);
    },
  }),
  startDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      await startDevContainer(appId);
      return reloadDevInfo(appId);
    },
  }),
  stopDev: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      await stopDevContainer(appId);
      return reloadDevInfo(appId);
    },
  }),
  resetDevWorkspace: t.field({
    type: DevInfoRef,
    authScopes: { capability: "deploy" },
    description:
      "DESTRUCTIVE: replace the workspace with a fresh copy of the source.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      await resetDevWorkspace(appId);
      return reloadDevInfo(appId);
    },
  }),
  deployDevWorkspace: t.field({
    type: "String",
    authScopes: { capability: "deploy" },
    description:
      "Deploy the current dev workspace files to production. Returns the deployment id.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      const dep = await deployDevWorkspace(appId);
      return dep.id;
    },
  }),
  addDevSshUser: t.field({
    type: DevSshUserRef,
    authScopes: { capability: "deploy" },
    args: { input: t.arg({ type: AddDevSshUserInputType, required: true }) },
    resolve: (_r, { input }) =>
      createDevSshUser({
        appId: input.appId,
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
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => startTunnel(appId),
  }),
  stopTunnel: t.field({
    type: "Boolean",
    authScopes: { capability: "deploy" },
    description: "Stop the VS Code tunnel (dev container keeps running). Returns true.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: async (_r, { appId }) => {
      await stopTunnel(appId);
      return true;
    },
  }),
}));

/** Reload dev info by project id after a void mutation so we can return it. */
async function reloadDevInfo(appId: string): Promise<DevInfo> {
  const info = await getDevInfo(appId);
  if (!info) throw new Error("App not found");
  return info;
}
