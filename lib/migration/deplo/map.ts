import { DB_REPOS } from "../../databases/images";
import type { BuildConfig, GitRepo } from "../../types/build";
import type { EnvPair, SharedRef } from "../map/env";
import { blocker, type Note } from "../note";
import type {
  SourceApplication,
  SourceBackupDestination,
  SourceBackupRun,
  SourceBackupSchedule,
  SourceCompose,
  SourceDatabase,
  SourceDbKind,
  SourceDomain,
  SourceEnvironment,
  SourceGitConnection,
  SourceMount,
  SourceProject,
  SourceSharedEnv,
} from "../model";
import type {
  DeploExport,
  DeploExportApp,
  DeploExportBackup,
  DeploExportBackupRun,
  DeploExportCron,
  DeploExportDatabase,
  DeploExportSharedVar,
  DeploExportVar,
} from "./export-shape";

const DB_KIND: Record<DeploExportDatabase["type"], SourceDbKind> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongodb: "mongo",
  redis: "redis",
  clickhouse: "clickhouse",
};

export function dbKindOf(d: Pick<DeploExportDatabase, "type">): SourceDbKind {
  return DB_KIND[d.type] ?? "unknown";
}

const pairs = (vars: DeploExportVar[]): EnvPair[] =>
  vars.map(({ key, value }) => ({ key, value }));

export function sharedVarsOf(vars: DeploExportVar[]): SourceSharedEnv | null {
  if (vars.length === 0) return null;
  return {
    envEntries: pairs(vars),
    secretEnvKeys: vars.filter((v) => v.secret).map((v) => v.key),
  };
}

export interface Placement {
  projectId: string;
  environmentId: string;
}

const TOP = "top";

// Deplo keeps apps outside any project; a migration lands everything in a project, so each folder (and the top level) becomes one.
export function placementOf(
  x: DeploExport,
  w: {
    projectId?: string | null;
    environmentId: string | null;
    folderId?: string | null;
  },
): Placement {
  if (w.environmentId) {
    const project = x.projects.find((p) =>
      p.environments.some((e) => e.id === w.environmentId),
    );
    if (project)
      return { projectId: project.id, environmentId: w.environmentId };
  }
  if (w.projectId) {
    const project = x.projects.find((p) => p.id === w.projectId);
    const env =
      project?.environments.find((e) => e.isDefault) ??
      project?.environments[0];
    if (project && env) return { projectId: project.id, environmentId: env.id };
  }
  const group = w.folderId ? `folder:${w.folderId}` : `${TOP}:${x.team.id}`;
  return { projectId: group, environmentId: `${group}:production` };
}

function folderPath(x: DeploExport, id: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let at: string | null = id; at && !seen.has(at);) {
    seen.add(at);
    const f = x.folders.find((r) => r.id === at);
    if (!f) break;
    names.unshift(f.name);
    at = f.parentId;
  }
  return names.join(" / ") || "Folder";
}

function backupsOf(rows: DeploExportBackup[]): SourceBackupSchedule[] {
  return rows.map((b) => ({
    schedule: b.schedule,
    enabled: b.enabled,
    keepLatestCount: b.retentionCount,
    destination: b.destination ? { name: b.destination } : null,
    timezone: b.timezone ?? null,
  }));
}

// Absent from an older source: say so, rather than let its restore points vanish quietly.
function backupHistoryOf(w: {
  backups: DeploExportBackup[];
  backupRuns?: DeploExportBackupRun[];
}): { backupRuns?: SourceBackupRun[]; notes: string[] } {
  if (w.backupRuns) return { backupRuns: w.backupRuns, notes: [] };
  return {
    notes:
      w.backups.length > 0
        ? [
            "{panel} is too old to send its backup history, so its restore points are not listed here. Restore from {panel}, or update it and import again.",
          ]
        : [],
  };
}

export function backupDestinationsOf(
  x: DeploExport,
): SourceBackupDestination[] {
  return [
    ...x.destinations.map((d) => ({ kind: "s3" as const, ...d })),
    ...(x.serverDestinations ?? []).map((d) => ({
      kind: "server" as const,
      ...d,
    })),
  ];
}

function domainsOf(
  a: DeploExportApp,
  compose: boolean,
): {
  domains: SourceDomain[];
  notes: string[];
} {
  const notes: string[] = [];
  const domains = a.domains.map((d, i): SourceDomain => {
    if (d.redirectTo)
      notes.push(
        `${d.host} only redirected to ${d.redirectTo} on {panel}, so it did not come across. Add it under Domains if you still need the redirect.`,
      );
    return {
      domainId: `${a.id}:${i}`,
      host: d.host,
      https: d.https,
      port: d.port,
      path: d.pathPrefix || "/",
      stripPath: d.stripPrefix,
      serviceName: d.service,
      domainType: compose ? "compose" : "application",
      certificateType:
        d.certProvider === "custom"
          ? "custom"
          : d.certProvider === "none" || d.certProvider === "cloudflare"
            ? "none"
            : "letsencrypt",
      enabled: !d.redirectTo,
      generated: d.generated,
      primary: d.primary,
    };
  });
  return { domains, notes };
}

function mountsOf(a: DeploExportApp, compose: boolean): SourceMount[] {
  const content = new Map(a.files.map((f) => [f.filePath, f.content]));
  if (compose)
    return a.files.map((f, i) => ({
      mountId: `${a.id}:file:${i}`,
      type: "file",
      filePath: f.filePath,
      content: f.content,
      mountPath: "",
    }));
  return a.volumes.map((v, i): SourceMount => {
    const mountId = `${a.id}:${i}`;
    if (v.type === "host")
      return {
        mountId,
        type: "bind",
        hostPath: v.hostPath,
        mountPath: v.mountPath,
        readOnly: v.readOnly,
      };
    if (v.type === "app")
      return {
        mountId,
        type: "file",
        filePath: v.projectPath,
        content: content.get(v.projectPath ?? "") ?? "",
        mountPath: v.mountPath,
        readOnly: v.readOnly,
      };
    return {
      mountId,
      type: "volume",
      volumeName: v.name,
      mountPath: v.mountPath,
      readOnly: v.readOnly,
    };
  });
}

// Which connection it clones with, from a source that says; the GitHub App never moves between instances.
function gitCredentialOf(
  x: DeploExport,
  repo: GitRepo | null,
): { gitConnection?: SourceGitConnection | null; notes: Note[] } {
  if (!repo) return { notes: [] };
  if (repo.installationId)
    return {
      gitConnection: null,
      notes: [
        blocker(
          `It cloned ${repo.repo} through the GitHub App on {panel}, which cannot move to another Deplo. Link a GitHub App under the app's Source settings before deploying.`,
        ),
      ],
    };
  if (!repo.connectionId) return { gitConnection: null, notes: [] };
  if (!x.gitConnections)
    return {
      gitConnection: null,
      notes: [
        blocker(
          `{panel} is too old to hand over the git connection ${repo.repo} clones with. Attach one under the app's Source settings before deploying.`,
        ),
      ],
    };
  const conn = x.gitConnections.find((g) => g.id === repo.connectionId);
  if (!conn)
    return {
      gitConnection: null,
      notes: [
        blocker(
          `The git connection ${repo.repo} cloned with on {panel} is gone there. Attach one under the app's Source settings before deploying.`,
        ),
      ],
    };
  return {
    gitConnection: {
      provider: conn.provider,
      label: conn.label,
      baseUrl: conn.baseUrl,
      allowPrivateEndpoint: conn.allowPrivateEndpoint,
      username: conn.username,
      token: conn.token,
    },
    notes: [],
  };
}

function repoFields(repo: GitRepo | null): Partial<SourceApplication> {
  if (!repo) return { sourceType: "git" };
  const [owner = "", ...rest] = repo.repo.split("/");
  const name = rest.join("/");
  const origin = (() => {
    try {
      return new URL(repo.url).origin;
    } catch {
      return null;
    }
  })();
  const common = {
    triggerType: repo.triggerType ?? "push",
    watchPaths: repo.watchPaths ?? [],
    enableSubmodules: repo.submodules === true,
  };
  switch (repo.provider) {
    case "github":
      return {
        ...common,
        sourceType: "github",
        owner,
        repository: name,
        branch: repo.branch,
      };
    case "gitlab":
      return {
        ...common,
        sourceType: "gitlab",
        gitlabPathNamespace: repo.repo,
        gitlabBranch: repo.branch,
        gitlab: { gitlabUrl: origin },
      };
    case "gitea":
      return {
        ...common,
        sourceType: "gitea",
        giteaOwner: owner,
        giteaRepository: name,
        giteaBranch: repo.branch,
        gitea: { giteaUrl: origin },
      };
    case "bitbucket":
      return {
        ...common,
        sourceType: "bitbucket",
        bitbucketOwner: owner,
        bitbucketRepositorySlug: name,
        bitbucketBranch: repo.branch,
      };
    default:
      return {
        ...common,
        sourceType: "git",
        customGitUrl: repo.url,
        customGitBranch: repo.branch,
      };
  }
}

interface EnvShape {
  envEntries: EnvPair[];
  previewEnvEntries: EnvPair[];
  previewSecretEnvKeys?: string[];
  secretEnvKeys: string[];
  productionOnlyEnvKeys: string[];
  sharedRefs: SharedRef[];
}

// A linked shared variable becomes a reference at the narrowest level that offers it here, so the import links it again.
export function appEnv(x: DeploExport, a: DeploExportApp): EnvShape {
  const own = new Set(a.env.map((e) => e.key));
  const at = placementOf(x, a);
  const refs: SharedRef[] = [];
  const copies: DeploExportVar[] = [];
  for (const v of x.sharedVars) {
    if (own.has(v.key)) continue;
    if (!v.appIds.includes(a.id) && !v.autoInject) continue;
    const level = levelFor(v, at);
    if (level) refs.push({ key: v.key, level, sharedKey: v.key, whole: true });
    else copies.push(v);
  }
  const runtime = [
    ...a.env.filter((e) => e.targets.includes("production")),
    ...copies,
  ];
  // A preview override replaces the app's variable of that name in a preview.
  const overrides = a.previewEnv ?? [];
  const previewVars = [
    ...a.env.filter(
      (e) =>
        !e.targets.includes("production") &&
        !overrides.some((o) => o.key === e.key),
    ),
    ...overrides,
  ];
  const secret = new Set([
    ...a.env.filter((e) => e.secret).map((e) => e.key),
    ...copies.filter((e) => e.secret).map((e) => e.key),
    ...x.sharedVars
      .filter((v) => v.secret && refs.some((r) => r.key === v.key))
      .map((v) => v.key),
  ]);
  return {
    envEntries: [
      ...pairs(runtime),
      ...refs.map((r) => ({ key: r.key, value: `\${{${r.level}.${r.key}}}` })),
    ],
    previewEnvEntries: pairs(previewVars),
    previewSecretEnvKeys: a.previewEnv
      ? previewVars.filter((e) => e.secret).map((e) => e.key)
      : undefined,
    secretEnvKeys: [...secret],
    productionOnlyEnvKeys: a.env
      .filter((e) => e.targets.includes("production"))
      .filter((e) => !e.targets.includes("preview"))
      .map((e) => e.key),
    sharedRefs: refs,
  };
}

function levelFor(
  v: DeploExportSharedVar,
  at: Placement,
): SharedRef["level"] | null {
  if (v.environmentIds.includes(at.environmentId)) return "environment";
  if (v.projectIds.includes(at.projectId)) return "project";
  if (v.teamWide) return "team";
  return null;
}

export function teamShared(x: DeploExport) {
  return sharedVarsOf(x.sharedVars.filter((v) => v.teamWide));
}

export function projectShared(x: DeploExport, projectId: string) {
  return sharedVarsOf(
    x.sharedVars.filter((v) => !v.teamWide && v.projectIds.includes(projectId)),
  );
}

export function environmentShared(x: DeploExport, at: Placement) {
  return sharedVarsOf(
    x.sharedVars.filter(
      (v) =>
        !v.teamWide &&
        !v.projectIds.includes(at.projectId) &&
        v.environmentIds.includes(at.environmentId),
    ),
  );
}

// A job from an older Deplo arrives as schedule and command alone.
function cronNotes(w: { crons: DeploExportCron[] }): string[] {
  const bare = w.crons.filter((j) => j.env === undefined).map((j) => j.name);
  return bare.length > 0
    ? [
        `{panel} is too old to hand over the variables and settings of cron job(s) ${bare.join(", ")}, so only the schedule and command came across. Check them under Crons.`,
      ]
    : [];
}

export function sourceApplication(
  x: DeploExport,
  a: DeploExportApp,
): SourceApplication | SourceCompose {
  const compose = a.source === "compose";
  const env = appEnv(x, a);
  const { domains, notes: domainNotes } = domainsOf(a, compose);
  const history = backupHistoryOf(a);
  const notes: Note[] = [
    ...a.notes,
    ...domainNotes,
    ...history.notes,
    ...cronNotes(a),
  ];
  if (a.source === "upload" && !a.upload)
    notes.push(
      a.upload === undefined
        ? "{panel} is too old to hand over its uploaded archive. Upload it again here before deploying."
        : "It had no archive uploaded on {panel}. Upload one here before deploying.",
    );
  if (a.rollbackKeep === undefined)
    notes.push(
      "{panel} is too old to hand over its compose flags, rollback count and deploy hook switch, so they start at Deplo's defaults. Check them under Settings.",
    );
  if (a.preview === undefined && a.previewEnabled)
    notes.push(
      "{panel} is too old to hand over its preview settings, so only previews being on came across. Check them under Previews.",
    );
  const common = {
    name: a.name,
    appName: a.slug,
    envEntries: env.envEntries,
    secretEnvKeys: env.secretEnvKeys,
    productionOnlyEnvKeys: env.productionOnlyEnvKeys,
    sharedRefs: env.sharedRefs,
    domains,
    mounts: mountsOf(a, compose),
    autoDeploy: a.autoDeploy,
    serverId: a.serverId,
    environmentId: placementOf(x, a).environmentId,
    backups: backupsOf(a.backups),
    backupRuns: history.backupRuns,
    routingPort: a.build.port,
    cronEnabled: a.cronEnabled ?? null,
    platformNotes: notes,
    previewEnvEntries: env.previewEnvEntries,
    previewSecretEnvKeys: env.previewSecretEnvKeys,
    nativePreview: a.preview
      ? { enabled: a.previewEnabled, ...a.preview }
      : undefined,
    registriesCarried: x.registries !== undefined,
    nativeOps:
      a.rollbackKeep === undefined
        ? undefined
        : {
            composeUpArgs: a.composeUpArgs ?? null,
            rollbackKeep: a.rollbackKeep,
            deployHook: a.deployHook ?? { enabled: true, used: false },
          },
  };
  if (compose)
    return {
      ...common,
      composeId: a.id,
      composeFile: a.compose,
      sourceType: "raw",
    } satisfies SourceCompose;

  const m = a.build.methodSettings;
  const origin: Partial<SourceApplication> =
    a.source === "docker-image"
      ? { sourceType: "docker", dockerImage: a.dockerImage }
      : a.source === "upload"
        ? { sourceType: "drop", upload: a.upload ?? null }
        : repoFields(a.repo);
  const git: ReturnType<typeof gitCredentialOf> =
    a.source === "docker-image" || a.source === "upload"
      ? { notes: [] }
      : gitCredentialOf(x, a.repo);
  notes.push(...git.notes);
  // A pending cache clear is this host's housekeeping, not a setting.
  const build: Partial<BuildConfig> = { ...a.build };
  delete build.buildCacheClearPending;
  return {
    ...common,
    ...origin,
    ...(git.gitConnection !== undefined
      ? { gitConnection: git.gitConnection }
      : {}),
    applicationId: a.id,
    sourceType: origin.sourceType ?? "git",
    buildType: a.build.buildMethod,
    dockerfile: m.dockerfilePath ?? null,
    dockerContextPath: m.dockerContextPath ?? null,
    dockerBuildStage: m.dockerBuildStage ?? null,
    railpackVersion: m.railpackVersion ?? null,
    isStaticSpa: m.staticSinglePageApp ?? null,
    publishDirectory:
      a.build.outputDirectory ?? m.nixpacksPublishDirectory ?? null,
    buildPath: a.build.rootDirectory || null,
    installCommand: a.build.installCommand,
    buildCommand: a.build.buildCommand,
    command: a.source === "docker-image" ? null : a.build.startCommand,
    isPreviewDeploymentsActive: a.previewEnabled,
    ports: a.ports.map((p) => ({
      portId: p.id,
      publishedPort: p.published,
      targetPort: p.target,
      protocol: p.protocol,
    })),
    security: a.basicAuth.map((b, i) => ({
      securityId: `${a.id}:auth:${i}`,
      username: b.username,
      password: b.password,
    })),
    healthCheck: a.healthCheck,
    icon: a.logo,
    nativeBuild: build,
    nativeResources: a.resources,
  } satisfies SourceApplication;
}

export function sourceDatabase(
  x: DeploExport,
  d: DeploExportDatabase,
): SourceDatabase {
  const kind = dbKindOf(d);
  const history = backupHistoryOf(d);
  return {
    [`${kind}Id`]: d.id,
    name: d.name,
    appName: d.host,
    dockerImage: d.customImage || `${DB_REPOS[d.type]}:${d.version}`,
    databaseName: d.dbName,
    databaseUser: d.username,
    databasePassword: d.password || null,
    command: d.customCommand,
    externalPort: d.exposedPort,
    nativeResources: d.resources,
    serverId: d.serverId,
    environmentId: placementOf(x, d).environmentId,
    mounts: d.mounts.map((m, i) => ({
      mountId: `${d.id}:${i}`,
      type: "file",
      filePath: m.filePath,
      content: m.content,
      mountPath: m.mountPath,
    })),
    backups: backupsOf(d.backups),
    backupRuns: history.backupRuns,
    cronEnabled: d.cronEnabled ?? null,
    platformNotes: [...d.notes, ...history.notes, ...cronNotes(d)],
  };
}

export function sourceTree(x: DeploExport): SourceProject[] {
  const projects = new Map<string, SourceProject>();
  const envs = new Map<string, SourceEnvironment>();
  const projectOf = (at: Placement): SourceEnvironment => {
    let project = projects.get(at.projectId);
    if (!project) {
      const real = x.projects.find((p) => p.id === at.projectId);
      const folder = at.projectId.startsWith("folder:")
        ? at.projectId.slice("folder:".length)
        : null;
      const shared = real ? projectShared(x, real.id) : null;
      project = {
        projectId: at.projectId,
        name: real?.name ?? (folder ? folderPath(x, folder) : x.team.name),
        envEntries: shared?.envEntries ?? null,
        secretEnvKeys: shared?.secretEnvKeys ?? null,
        platformNotes: [
          ...(real
            ? []
            : [
                folder
                  ? `These were in the ${folderPath(x, folder)} folder on {panel}, outside any project, so they came across as a project of that name.`
                  : "These were at the top level on {panel}, outside any project, so they came across as a project named after the team.",
              ]),
        ],
        environments: [],
      };
      projects.set(at.projectId, project);
    }
    let env = envs.get(at.environmentId);
    if (!env) {
      const real = x.projects
        .find((p) => p.id === at.projectId)
        ?.environments.find((e) => e.id === at.environmentId);
      const shared = environmentShared(x, at);
      env = {
        environmentId: at.environmentId,
        name: real?.name ?? "production",
        isDefault: real?.isDefault ?? true,
        envEntries: shared?.envEntries ?? [],
        secretEnvKeys: shared?.secretEnvKeys ?? null,
        applications: [],
        compose: [],
      };
      envs.set(at.environmentId, env);
      project.environments!.push(env);
    }
    return env;
  };

  for (const p of x.projects)
    for (const e of p.environments)
      projectOf({ projectId: p.id, environmentId: e.id });
  for (const a of x.apps) {
    const env = projectOf(placementOf(x, a));
    const row = sourceApplication(x, a);
    if ("composeId" in row) env.compose!.push(row);
    else env.applications!.push(row as SourceApplication);
  }
  for (const d of x.databases) {
    const env = projectOf(placementOf(x, d));
    const kind = dbKindOf(d);
    ((env[kind] ??= []) as SourceDatabase[]).push(sourceDatabase(x, d));
  }
  const tree = [...projects.values()].filter((p) =>
    (p.environments ?? []).some(hasServices),
  );
  if (x.withheld > 0 && tree[0])
    tree[0].platformNotes = [
      ...(tree[0].platformNotes ?? []),
      `${x.withheld} app${x.withheld === 1 ? " is" : "s are"} in folders this token cannot open on {panel}, so ${x.withheld === 1 ? "it was" : "they were"} left out. Share those folders with the token's owner and run the migration again.`,
    ];
  return tree;
}

function hasServices(e: SourceEnvironment): boolean {
  return (
    (e.applications?.length ?? 0) > 0 ||
    (e.compose?.length ?? 0) > 0 ||
    Object.values(DB_KIND).some(
      (k) => ((e[k] as SourceDatabase[] | null | undefined)?.length ?? 0) > 0,
    )
  );
}
