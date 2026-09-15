import { builder } from "../../builder";
import { ResourceLimitsRef } from "../resource-limits";
import { HealthCheckRef } from "../health-check";
import { DeploySourceEnum, AppStatusEnum } from "../enums";
import { DeploymentRef } from "./deployment-object";
import { listApps } from "@/lib/data/apps/listing";
import type { AppSummary } from "@/lib/data/apps/summary";
import { effectiveFramework } from "@/lib/apps/framework-catalog";
import { listDeployments } from "@/lib/data/deployments/deployment-queries";
import { redactComposeForDisplay } from "@/lib/deploy/compose-redact";
import { MOUNT_PROPAGATIONS } from "@/lib/types/container";
import type { PublishedPort, VolumeMount } from "@/lib/types/container";
import { hasAppCapability } from "@/lib/data/node-access";

export const MountPropagationEnum = builder.enumType("MountPropagation", {
  description:
    "How mounts appearing UNDER a host bind mount cross between the server and " +
    "the container. Null is docker's `rprivate` default: the container sees only " +
    "the submounts that existed when it started, so a network disk, a FUSE share " +
    "or a volume another container mounts there never appears. `rslave` keeps " +
    "following the server; `rshared` is two-way. Host binds only - docker rejects " +
    "the option on a managed volume.",
  values: MOUNT_PROPAGATIONS,
});

// An enum, not a String: an unknown value used to fall through to a managed volume, with no error.
export const VolumeKindEnum = builder.enumType("VolumeKind", {
  description:
    'What the mount is: "named" is a Volume Deplo creates and keeps, "app" a ' +
    'File in the app\'s own files directory, "host" a Bind to a folder that ' +
    'already exists on the server. "service" is the volume editor\'s older ' +
    'spelling of "app" and still accepted.',
  values: ["named", "app", "service", "host"] as const,
});

const VolumeRef = builder.objectRef<VolumeMount>("Volume").implement({
  description:
    "A persistent volume mounted into an app - a docker named volume, an " +
    "app-files bind, or a host bind mount.",
  fields: (t) => ({
    id: t.exposeID("id"),
    type: t.string({ resolve: (v) => v.type ?? "named" }),
    name: t.exposeString("name"),
    projectPath: t.exposeString("projectPath", { nullable: true }),
    hostPath: t.exposeString("hostPath", { nullable: true }),
    service: t.string({ nullable: true, resolve: (v) => v.service ?? null }),
    mountPath: t.exposeString("mountPath"),
    readOnly: t.exposeBoolean("readOnly"),
    propagation: t.field({
      type: MountPropagationEnum,
      nullable: true,
      resolve: (v) => v.propagation ?? null,
    }),
  }),
});

const PublishedPortRef = builder
  .objectRef<PublishedPort>("PublishedPort")
  .implement({
    description:
      "A host port an app publishes, for what the proxy cannot route - a game " +
      "server, an SMTP relay, a database the app exposes.",
    fields: (t) => ({
      id: t.exposeID("id"),
      published: t.exposeInt("published", {
        description: "The port on the host.",
      }),
      target: t.exposeInt("target", {
        description: "The port inside the container.",
      }),
      protocol: t.string({ resolve: (p) => p.protocol }),
    }),
  });

export const AppRef = builder.objectRef<AppSummary>("App").implement({
  description: "A deployable application owned by a team.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
    teamId: t.exposeID("teamId"),
    folderId: t.exposeID("folderId", { nullable: true }),
    projectId: t.field({
      type: "ID",
      nullable: true,
      description: "The Project container this app belongs to, if any.",
      resolve: (p) => p.projectId ?? null,
    }),
    serverId: t.exposeID("serverId"),
    buildServerId: t.id({
      nullable: true,
      description:
        "The server that BUILDS this app's image, when that is not `serverId`. Null is Automatic: a build-only server if the fleet has one this team can reach and its architecture matches, otherwise build where the app runs. Setting it to `serverId` means 'always build on this app's own server'. Ignored by a compose stack and a docker-image source, neither of which Deplo builds.",
      resolve: (p) => p.buildServerId ?? null,
    }),
    buildFallback: t.boolean({
      description:
        "Build somewhere else when this app's build server cannot be reached, saying so in the deploy log: the servers marked as a build fallback (the Deplo host by default), then the app's own server. True by default. False fails the deploy instead, for whoever chose a small deploy server on purpose.",
      resolve: (p) => p.buildFallback,
    }),
    logo: t.exposeString("logo", { nullable: true }),
    logoTone: t.exposeString("logoTone", {
      nullable: true,
      description:
        'The plate this app\'s icon needs to stay visible: "dark" for a mark drawn only in black, "light" for one drawn only in white. Set only when the logo came from a template - an uploaded or detected one is drawn exactly as it is.',
    }),
    dataCopyError: t.exposeString("dataCopyError", {
      description:
        "Why this app's data did not arrive, when a migration tried to copy it and could not. Empty for every app that was never migrated and every copy that worked. While it is set, deploying and starting this app are refused - its volumes are empty or half written - and `deployWithoutMigratedData` is how someone accepts that and unblocks it.",
    }),
    framework: t.string({
      nullable: true,
      description:
        "The JavaScript framework backing this app " +
        '("nextjs", "astro", "nestjs", …), or null when none was found or the ' +
        "app doesn't build with one of the auto-detecting builders (Nixpacks / " +
        "Railpack). Detected on every deploy, unless setAppFramework has " +
        "corrected it - in which case that choice is what this returns.",
      resolve: (p) => effectiveFramework(p),
    }),
    frameworkDetected: t.exposeString("framework", {
      nullable: true,
      description:
        "What the LAST DEPLOY actually read from the source, ignoring any " +
        "correction. Equals `framework` unless the user overrode it.",
    }),
    source: t.field({ type: DeploySourceEnum, resolve: (p) => p.source }),
    dockerImage: t.exposeString("dockerImage", { nullable: true }),
    compose: t.string({
      nullable: true,
      description:
        "The authored compose file. Its inline values are masked unless you can configure the app.",
      resolve: async (p) =>
        p.compose == null
          ? null
          : (await hasAppCapability(p.id, "configure_apps"))
            ? p.compose
            : redactComposeForDisplay(p.compose),
    }),
    volumes: t.field({
      type: [VolumeRef],
      description: "Persistent volumes mounted into this app.",
      resolve: (p) => p.volumes ?? [],
    }),
    ports: t.field({
      type: [PublishedPortRef],
      description:
        "Host ports this app publishes. Empty for a compose stack, which " +
        "publishes its own in its compose file.",
      resolve: (p) => p.ports ?? [],
    }),
    resources: t.field({
      type: ResourceLimitsRef,
      nullable: true,
      description:
        "Per-app resource caps applied at deploy time, or null when the app " +
        "has no limits set.",
      resolve: (p) => p.resources,
    }),
    healthCheck: t.field({
      type: HealthCheckRef,
      nullable: true,
      description:
        "The health check baked into this app's compose, or null when it has none.",
      resolve: (p) => p.healthCheck,
    }),
    productionUrl: t.exposeString("productionUrl", { nullable: true }),
    status: t.field({ type: AppStatusEnum, resolve: (p) => p.status }),
    autoDeploy: t.exposeBoolean("autoDeploy"),
    deployHookEnabled: t.exposeBoolean("deployHookEnabled", {
      description:
        "Whether this app's deploy hook answers. The hook URL itself is never " +
        "a field - read it back with revealAppDeployHook.",
    }),
    composeUpArgs: t.exposeString("composeUpArgs", {
      nullable: true,
      description:
        "Extra flags this app appends to the `docker compose up` that brings " +
        "it up, or null for the untouched command. Additive only - the flags " +
        "that choose the project, stack file or env-file are refused.",
    }),
    rollbackKeep: t.exposeInt("rollbackKeep", {
      description:
        "How many previous deployments this app can be rolled back to (0-20, " +
        "default 3). Retention: its server keeps this many of the app's images " +
        "behind the running one. 0 means there is nothing to go back to.",
    }),
    domainCount: t.exposeInt("domainCount"),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt"),
    latestDeployment: t.field({
      type: DeploymentRef,
      nullable: true,
      resolve: (p) => p.latestDeployment,
    }),
    deployments: t.field({
      type: [DeploymentRef],
      description:
        "The app's most recent deployments, newest first (capped so a nested " +
        "query can't fan out over the whole history + per-deployment logs).",
      resolve: (p) => listDeployments({ appId: p.id, limit: 100 }),
    }),
  }),
});

export async function reloadApp(id: string): Promise<AppSummary> {
  const all = await listApps();
  const found = all.find((p) => p.id === id);
  if (!found) throw new Error("App not found");
  return found;
}
