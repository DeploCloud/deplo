import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  apps as appsTable,
  appBuild as appBuildTable,
  appBuildMethodSettings as appBuildMethodSettingsTable,
  appMounts as appMountsTable,
} from "../../db/schema/control-plane/apps";
import { pendingTeardowns as pendingTeardownsTable } from "../../db/schema/control-plane/deployments";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import { requireCapability, requireMembership } from "../../membership";
import { canHostWorkloads, listServersForTeam } from "../servers/roster";
import { assertServerAccessibleTx } from "../servers/team-access";
import { isReservedSharedName } from "../../deploy/compose-lint/networks";
import {
  assertNoNameClash,
  namesOnNetwork,
  namesTakenOnNetwork,
  withNetworkLock,
} from "../name-clash";
import { renameClashingServices } from "../../migration/map/compose-rename";
import { renameHostTokens } from "../../migration/map/env";
import { appSlugFromDeployKey, stackName } from "../../deploy/deploy-key";
import {
  composeNamesOnNetwork,
  composeServicePort,
  detectDefaultApp,
} from "../../deploy/compose-stack/compose-read";
import {
  parseComposeUpArgs,
  validateComposeUpArgs,
} from "../../deploy/compose-args";
import { DEFAULT_ROLLBACK_KEEP } from "../../types/app";
import { encryptSecret } from "../../crypto";
import type { EnvEntryType } from "../../deploy/env-resolve";
import { recordActivity } from "../activity";
import { setSharedVarAppLink } from "../shared-vars/app-links";
import { imageExposedPort } from "../../registry/client";
import { buildConfigFor } from "../../frameworks";
import type { App, DeploySource } from "../../types/app";
import type { BuildConfig, GitRepo } from "../../types/build";
import type { EnvTarget, EnvVar } from "../../types/env";
import { startDeployment } from "../../deploy/build/deploy-start";
import { ensureAutoDomain, ensureExtraDomain } from "../domains/auto-domains";
import { isHostnameClaim } from "../domains/hostname-claim";
import {
  blueprintWantsTls,
  instanceHost,
  productionDomain,
  rehostBlueprintHosts,
  resolveServerIp,
} from "../../deploy/domains";
import { isValidLogoValue } from "../../apps/logo-shared";
import { logoToneFromDataUri } from "../../apps/logo-tone";
import { getTemplateBlueprint } from "../../templates-blueprint";
import { DEFAULT_VARIANT_SLUG } from "@/templates/types";
import { getTemplateVariant, templateLogoDataUri } from "@/templates/catalog";
import { syncAppWebhook } from "../git-connections";
import { insertEnvVars, loadAppGraph } from "../app-graph-load";
import { appToRow, mountsToRows } from "../app-graph-rows/app";
import { buildToRow, methodSettingsToRow } from "../app-graph-rows/build";
import { hasAppCapability } from "../node-access";
import { summarizeOne, type AppSummary } from "./summary";
import { resolveNewAppPlacement, resolvePlacement } from "./placement";
import {
  ON_IMPORT_SOURCE,
  assertComposeSavable,
  assertImageRef,
  scopeRepoCredentials,
} from "./source-guards";

// True if `err` is a Postgres unique violation (23505) on that constraint - retries the slug pick.
function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const o = e as { code?: string; constraint?: string; message?: string };
    if (o.code === "23505") {
      return (
        o.constraint === constraint ||
        (o.message?.includes(constraint) ?? false)
      );
    }
  }
  return false;
}

// Same grammar as env.ts: a key with a newline or quote would break out of the templated `environment:` block.
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

const APP_NAME_MAX = 60;

// cleanAppName trims and caps an app name, so a multi-MB name cannot bloat every RSC payload.
export function cleanAppName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("App name is required.");
  if (trimmed.length > APP_NAME_MAX)
    throw new Error(`App name must be ${APP_NAME_MAX} characters or fewer.`);
  return trimmed;
}

const MAX_MOUNT_BYTES = 1024 * 1024;

// A config file's path inside the app's Files dir: `..` and the stack's own env-file are refused.
function cleanMountPath(raw: string): string {
  const rel = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "")
    .replace(/\/$/, "");
  if (!rel || rel === ".")
    throw new Error("Give each config file a path inside the app's files");
  if (rel.split("/").some((seg) => seg === ".."))
    throw new Error(
      `A config file path must stay inside the app's files: ${raw}`,
    );
  if (/[\u0000-\u001f:$]/.test(rel))
    throw new Error(`A config file path can't contain that character: ${raw}`);
  if (rel === ".env")
    throw new Error(
      "The .env file is written by Deplo from the app's variables - edit those in Settings → Environment.",
    );
  return rel;
}

export interface CreateAppInput {
  name: string;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage?: string | null;
  logo?: string | null;
  logoFromTemplate?: boolean;
  compose?: string | null;
  env?: { key: string; value: string; type?: EnvEntryType }[];
  serverId?: string;
  buildServerId?: string | null;
  build?: Partial<BuildConfig>;
  autoDeploy?: boolean;
  composeService?: string | null;
  composePort?: number | null;
  extraDomains?:
    | { service: string; port: number; host: string; path?: string | null }[]
    | null;
  autoDomain?: string | null;
  autoDomainPath?: string | null;
  noAutoDomain?: boolean;
  mounts?: { filePath: string; content: string }[] | null;
  renameClashes?: boolean;
  composeUpArgs?: string | null;
  sharedVarIds?: string[] | null;
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  deploy?: boolean;
}

export interface CreateAppFromTemplateInput {
  templateSlug: string;
  variantSlug?: string;
  name?: string;
  serverId?: string;
  projectId?: string;
  environmentId?: string;
  folderId?: string;
  deploy?: boolean;
}

// ComposeNameClash: one service name a stack would share with a neighbour, and its way out.
export interface ComposeNameClash {
  name: string;
  owner: string;
  renamedTo: string;
}

// composeNameClashes says what createApp would refuse this stack over, BEFORE it is asked.
export async function composeNameClashes(
  input: Pick<
    CreateAppInput,
    "compose" | "serverId" | "folderId" | "projectId" | "environmentId"
  >,
): Promise<ComposeNameClash[]> {
  const { teamId } = await requireCapability("create_apps");
  const compose = input.compose?.trim();
  if (!compose) return [];
  const placement = await resolvePlacement(input, teamId);
  const deployable = (await listServersForTeam(teamId)).filter(
    canHostWorkloads,
  );
  const server =
    (input.serverId && deployable.find((s) => s.id === input.serverId)) ||
    deployable[0];
  if (!server) return [];
  const taken = await namesOnNetwork(
    { teamId, environmentId: placement.environmentId, serverId: server.id },
    "",
  );
  const mine = [
    ...new Set(composeNamesOnNetwork(compose).map((n) => n.toLowerCase())),
  ].filter((n) => taken.has(n));
  if (mine.length === 0) return [];
  const { renames } = renameClashingServices(
    compose,
    new Set(mine),
    null,
    new Set(taken.keys()),
  );
  return mine.map((name) => ({
    name,
    owner: taken.get(name)!,
    renamedTo: renames.get(name) ?? name,
  }));
}

// withImagePort asks the registry what the image declares, so a Docker-image app is not guessed onto 3000.
async function withImagePort(
  input: Pick<CreateAppInput, "source" | "dockerImage" | "build">,
): Promise<Partial<BuildConfig> | undefined> {
  const image = input.dockerImage?.trim();
  if (input.source !== "docker-image" || !image) return input.build;
  if (input.build?.port) return input.build;
  const port = await imageExposedPort(image).catch(() => null);
  return port ? { ...input.build, port } : input.build;
}

// createApp gates `create_apps` on the DESTINATION (resolvePlacement): a node grant can hold it where the role does not.
export async function createApp(input: CreateAppInput): Promise<AppSummary> {
  const { membership, userId } = await requireMembership();
  input = { ...input, name: cleanAppName(input.name) };
  assertImageRef(input.source, input.dockerImage);

  // Asked BEFORE anything is written: refusing after the insert would leave the app created and the mutation failed.
  if (input.sharedVarIds?.length) await requireCapability("manage_env");
  const reach = await assertComposeSavable(input.compose);

  // A REAL hostname is a domain claim (`domains.name` is instance-unique); our own nip.io hosts are not.
  const claimsAHostname = [
    input.autoDomain,
    ...(input.extraDomains ?? []).map((e) => e.host),
  ].some(isHostnameClaim);
  if (claimsAHostname) await requireCapability("manage_domains");
  const placement = await resolveNewAppPlacement(input, membership.teamId);
  const user = (await getCurrentUser())!;
  const slugBase = input.name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // The optimistic slug pick races a concurrent same-name create; the INSERT retries on `apps_slug_uq`.
  const existing = new Set(
    (await getDb().select({ slug: appsTable.slug }).from(appsTable)).map(
      (r) => r.slug,
    ),
  );

  // A slug still awaiting teardown stays taken, or the new app adopts the old one's volumes and files.
  for (const p of await getDb()
    .select({ deployKey: pendingTeardownsTable.deployKey })
    .from(pendingTeardownsTable))
    existing.add(appSlugFromDeployKey(p.deployKey));
  const slugRoot = slugBase || `project-${newId("").slice(1, 6)}`;

  // `deplo-<slug>` is the container name and the name it answers to on the network (ADR-0029).
  const taken = (s: string): boolean =>
    existing.has(s) || isReservedSharedName(stackName(s));
  let i = 1;
  let slug = slugRoot;
  while (taken(slug)) slug = `${slugRoot}-${i++}`;
  const nextSlug = (): string => {
    let s = `${slugRoot}-${i++}`;
    while (taken(s)) s = `${slugRoot}-${i++}`;
    return s;
  };

  const servers = await listServersForTeam(membership.teamId);
  if (input.serverId && !servers.some((s) => s.id === input.serverId))
    throw new Error("That server isn't available to this team.");
  const deployable = servers.filter(canHostWorkloads);
  if (input.serverId && !deployable.some((s) => s.id === input.serverId))
    throw new Error("That server doesn't run apps.");
  const server =
    (input.serverId && deployable.find((s) => s.id === input.serverId)) ||
    deployable[0];
  if (!server)
    throw new Error(
      "No server available - add a server from Settings, Servers and run its install command first.",
    );
  let buildServerId: string | null = null;
  if (input.buildServerId) {
    const picked = servers.find((b) => b.id === input.buildServerId);
    if (!picked)
      throw new Error("That build server isn't available to this team.");
    if (picked.storageOnly)
      throw new Error(
        "That server holds backups only - it has no Docker to build with.",
      );
    if (picked.importOnly) throw new Error(ON_IMPORT_SOURCE);
    buildServerId = picked.id;
  }

  const rawComposeArgs = input.composeUpArgs?.trim() || null;
  if (rawComposeArgs) {
    const problem = validateComposeUpArgs(rawComposeArgs);
    if (problem) throw new Error(problem);
  }

  const serverIp = resolveServerIp(server);
  const hosts = rehostBlueprintHosts(
    {
      autoDomain: input.autoDomain,
      extraDomains: input.extraDomains,
      env: input.env,
    },
    instanceHost(),
    serverIp,
  );
  input.autoDomain = hosts.autoDomain;
  input.extraDomains = hosts.extraDomains;
  input.env = hosts.env;

  // ponytail: renamed before the lock, like the import; a concurrent clashing
  // create in the gap falls back to the refusal below, never to a collision.
  const renameNotes: string[] = [];
  if (input.renameClashes && input.compose) {
    const mine = new Set(
      composeNamesOnNetwork(input.compose).map((n) => n.toLowerCase()),
    );
    const taken = await namesTakenOnNetwork({
      teamId: membership.teamId,
      environmentId: placement.environmentId,
      serverId: server.id,
    });
    const renamed = renameClashingServices(
      input.compose,
      new Set([...taken].filter((n) => mine.has(n))),
      null,
      taken,
    );
    if (renamed.renames.size > 0) {
      const moved = (svc: string): string =>
        renamed.renames.get(svc.toLowerCase()) ?? svc;
      input.compose = renamed.compose;
      if (input.composeService)
        input.composeService = moved(input.composeService);
      input.extraDomains = input.extraDomains?.map((d) => ({
        ...d,
        service: moved(d.service),
      }));
      if (input.env) renameHostTokens(input.env, renamed.renames);
      input.mounts = input.mounts?.map((m) => {
        const e = { key: "", value: m.content };
        renameHostTokens([e], renamed.renames);
        return { ...m, content: e.value };
      });
      renameNotes.push(...renamed.changes);
    }
  }

  if (input.mounts)
    input.mounts = input.mounts.map((m) => {
      if (Buffer.byteLength(m.content ?? "", "utf8") > MAX_MOUNT_BYTES)
        throw new Error(
          `${m.filePath} is too large for a config file (1 MiB max)`,
        );
      return { ...m, filePath: cleanMountPath(m.filePath) };
    });

  const isUpload = input.source === "upload";

  const logo = input.logo && isValidLogoValue(input.logo) ? input.logo : null;

  const project: App = {
    id: newId("prj"),
    name: input.name.trim(),
    slug,
    teamId: membership.teamId,
    folderId: placement.folderId,
    projectId: placement.projectId,
    environmentId: placement.environmentId,
    serverId: server.id,
    dataCopyError: "",
    migrationRunId: null,
    buildServerId,
    buildFallback: true,
    logo,
    logoTone: input.logoFromTemplate ? await logoToneFromDataUri(logo) : null,
    framework: null,
    frameworkOverride: null,
    source: input.source,
    repo: await scopeRepoCredentials(input.repo, membership.teamId),
    dockerImage: input.dockerImage ?? null,
    upload: null,
    compose: input.compose ?? null,
    mounts: input.mounts?.length ? input.mounts : null,
    build: buildConfigFor(await withImagePort(input)),
    productionUrl: null,
    status: isUpload ? "idle" : "queued",
    previewEnabled: false,
    cronEnabled: false,
    consoleEnabled: false,
    autoDeploy: input.autoDeploy ?? true,
    deployHookEnabled: true,
    composeUpArgs: rawComposeArgs
      ? parseComposeUpArgs(rawComposeArgs).join(" ")
      : null,
    rollbackKeep: DEFAULT_ROLLBACK_KEEP,
    resources: null,
    healthCheck: null,
    latestDeploymentId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const now = nowIso();
  const appEnvVars: EnvVar[] = (input.env ?? [])
    .filter((e) => e.key.trim())
    .map((e) => {
      const key = e.key.trim();
      if (!ENV_KEY_RE.test(key))
        throw new Error(`Invalid variable name: ${key}`);
      return {
        id: newId("env"),
        appId: project.id,
        key,
        valueEnc: encryptSecret(e.value),
        targets: ["production", "preview"] as EnvTarget[],
        type: e.type ?? ("plain" as const),
        createdByUserId: userId,
        updatedByUserId: userId,
        createdAt: now,
        updatedAt: now,
      } satisfies EnvVar;
    });

  await withNetworkLock(
    { teamId: membership.teamId, environmentId: placement.environmentId },
    async () => {
      if (input.compose != null)
        await assertNoNameClash({
          to: {
            teamId: membership.teamId,
            environmentId: placement.environmentId,
            serverId: server.id,
          },
          claims: composeNamesOnNetwork(input.compose),
          exceptId: "",
          subject: "this app",
        });
      for (let attempt = 0; ; attempt++) {
        try {
          await getDb().transaction(async (tx) => {
            // Re-asserted inside the tx so a concurrent setServerTeams restrict cannot land this app on a lost server.
            await assertServerAccessibleTx(tx, server.id, membership.teamId);

            // created_by_user_id / host_reach_by ride with the insert: read only by the delete-a-user
            // flow and the deploy's grant check, never by the renderer or a capability check.
            await tx.insert(appsTable).values({
              ...appToRow(project),
              createdByUserId: userId,
              hostReachBy: reach.length > 0 ? userId : null,
            });
            await tx
              .insert(appBuildTable)
              .values(buildToRow(project.id, project.build));
            await tx
              .insert(appBuildMethodSettingsTable)
              .values(
                methodSettingsToRow(project.id, project.build.methodSettings),
              );
            const mountRows = mountsToRows(project.id, project.mounts);
            if (mountRows.length > 0)
              await tx.insert(appMountsTable).values(mountRows);
            if (appEnvVars.length > 0) await insertEnvVars(tx, appEnvVars);
          });
          break;
        } catch (e) {
          if (attempt < 5 && isUniqueViolation(e, "apps_slug_uq")) {
            project.slug = slug = nextSlug();
            continue;
          }
          throw e;
        }
      }
    },
  );
  await recordActivity(
    "app",
    `Created app ${project.name}`,
    user.name,
    project.id,
  );
  for (const note of renameNotes)
    await recordActivity("app", note, user.name, project.id);
  await syncAppWebhook(project.repo).catch(() => {});

  const ip = resolveServerIp(server);
  const namedPort =
    input.composeService && input.compose
      ? composeServicePort(input.compose, input.composeService)
      : null;
  const detected =
    input.composeService && (input.composePort ?? namedPort)
      ? {
          service: input.composeService,
          port: (input.composePort ?? namedPort)!,
        }
      : input.compose
        ? detectDefaultApp(input.compose)
        : null;

  // Auto domains are born plain-HTTP; only a blueprint that baked an `https://` host of its own opts in.
  const certProvider = blueprintWantsTls(
    [input.autoDomain, ...(input.extraDomains ?? []).map((e) => e.host)],
    [
      input.compose,
      ...(input.env ?? []).map((e) => e.value),
      ...(input.mounts ?? []).map((m) => m.content),
    ],
  )
    ? "letsencrypt"
    : "none";

  // The ONLY place an auto domain is born - deploys never create one, so a deleted one stays deleted.
  if (!input.noAutoDomain)
    await ensureAutoDomain(project.id, {
      slug,
      ip,
      preferred: input.autoDomain ?? undefined,
      preferredPath: input.autoDomainPath ?? undefined,
      defaultPort: detected?.port ?? project.build.port,
      defaultApp: detected?.service ?? null,
      certProvider,
    });

  // Every extra hostname is registered ONCE, here, never on a deploy.
  for (const ex of input.extraDomains ?? []) {
    await ensureExtraDomain(project.id, ex.host.trim(), {
      port: ex.port,
      service: ex.service,
      pathPrefix: ex.path ?? undefined,
      slug,
      ip,
      certProvider,
    });
  }

  // Linked BEFORE the deploy below, or the first build would run without them.
  for (const varId of input.sharedVarIds ?? []) {
    await setSharedVarAppLink(varId, project.id, true);
  }

  // `create_apps` is NOT `deploy_apps`: the deploy is asked for ON THE NEW APP, else the app is born idle.
  const wantsDeploy = input.deploy !== false;
  if (
    !isUpload &&
    wantsDeploy &&
    (await hasAppCapability(project.id, "deploy_apps"))
  ) {
    await startDeployment(project.id, {
      environment: "production",
      creator: user.name,
      commitMessage: "Initial deployment",
    });
  } else if (!isUpload) {
    await getDb()
      .update(appsTable)
      .set({ status: "idle", updatedAt: nowIso() })
      .where(eq(appsTable.id, project.id));
  }

  return summarizeOne((await loadAppGraph(project.id))!);
}

export async function createAppFromTemplate(
  input: CreateAppFromTemplateInput,
): Promise<AppSummary> {
  const template = await getTemplateVariant(
    input.templateSlug,
    input.variantSlug?.trim() || DEFAULT_VARIANT_SLUG,
  );
  if (!template) throw new Error("That template or variant isn't available.");

  const autoDomain = productionDomain(template.slug, instanceHost());
  const blueprint = getTemplateBlueprint(template, { domain: autoDomain });
  const logo = await templateLogoDataUri(template.variant.logo);

  return createApp({
    name: input.name?.trim() || template.name,
    source: "compose",
    repo: null,
    logo,
    logoFromTemplate: true,
    compose: blueprint.compose,
    env: blueprint.env,
    autoDeploy: false,
    composeService: blueprint.expose?.service ?? null,
    composePort: blueprint.expose?.port ?? null,
    extraDomains: blueprint.exposes.slice(1).map((expose) => ({
      service: expose.service,
      port: expose.port,
      host: expose.host ?? "",
      path: expose.path ?? null,
    })),
    autoDomain,
    autoDomainPath: blueprint.expose?.path ?? null,
    mounts: blueprint.mounts,
    serverId: input.serverId,
    projectId: input.projectId ?? null,
    environmentId: input.environmentId ?? null,
    folderId: input.folderId ?? null,
    deploy: input.deploy ?? false,
    renameClashes: true,
  });
}
