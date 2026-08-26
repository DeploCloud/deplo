// https://deplo.build/docs/guides/move-from-dokploy

/**
 * Dokploy row → deplo input. The convention for anything that cannot be
 * represented: return the value that IS representable and add a line to `notes`.
 */

import yaml, {
  isMap,
  isScalar,
  isSeq,
  Scalar,
  type Document,
  type YAMLMap,
} from "../yaml";

import { isValidLogoValue } from "../apps/logo-shared";
import { keepAuthoredEnvText } from "../deploy/compose-lint";

import type {
  BuildConfig,
  BuildMethod,
  CertProvider,
  DatabaseType,
  DomainEntrypoint,
  GitRepo,
  ResourceLimits,
  VolumeMount,
} from "../types";
import type {
  DokployApplication,
  DokployCompose,
  DokployDatabase,
  DokployDbKind,
  DokployDomain,
  DokployMount,
} from "./client";

/** Same shape as `ResourceLimitsInput` in lib/data/apps.ts, without importing a
 *  `server-only` module into a file that must stay client-safe. */
export type ResourceInput = {
  [K in keyof ResourceLimits]?: ResourceLimits[K] | null;
};

/** What a mapper produces: the deplo input plus what could not come across. */
export interface Mapped<T> {
  value: T;
  notes: string[];
}

/** deplo's env-var key grammar (`KEY_RE` in lib/data/env.ts). */
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/* ------------------------------------------------------------------ */
/* Env blobs                                                           */
/* ------------------------------------------------------------------ */

/**
 * Dokploy keeps env as one `.env`-shaped text column; deplo keeps rows.
 */
export function parseEnvBlob(blob: string | null | undefined): {
  key: string;
  value: string;
}[] {
  if (!blob) return [];
  const out: { key: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const raw of blob.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    if (!KEY_RE.test(key)) continue;
    // Last one wins, like a shell sourcing the file twice.
    if (seen.has(key))
      out[out.findIndex((e) => e.key === key)] = { key, value };
    else {
      seen.add(key);
      out.push({ key, value });
    }
  }
  return out;
}

/**
 * Dokploy's own template syntax for pulling a value in from the project or a
 * sibling service (`${{project.KEY}}`). deplo resolves nothing at deploy time, so
 * such a value would reach the container literally.
 */
export function envNeedsInterpolation(
  entries: { key: string; value: string }[],
): string[] {
  return entries.filter((e) => e.value.includes("${{")).map((e) => e.key);
}

/* ------------------------------------------------------------------ */
/* Compose: drop the source platform's shared network                  */
/* ------------------------------------------------------------------ */

const DOKPLOY_NETWORK = "dokploy-network";

/**
 * The maps a compose file writes a SERVICE's keys into: the services themselves,
 * and the top-level `x-*` blocks the services merge from. An anchor is where the
 * value really lives, so a rewrite that skips it edits a copy.
 */
function serviceLikeMaps(root: YAMLMap): { name: string; map: YAMLMap }[] {
  const out: { name: string; map: YAMLMap }[] = [];
  const services = root.get("services");
  if (isMap(services))
    for (const item of services.items)
      if (isMap(item.value))
        out.push({
          name: String((item.key as Scalar).value),
          map: item.value,
        });
  for (const item of root.items) {
    const name = String((item.key as Scalar | null)?.value ?? "");
    if (name.startsWith("x-") && isMap(item.value))
      out.push({ name, map: item.value });
  }
  return out;
}

/** The Scalar node at `map[key]`, when it holds a string. Its `value` is editable
 *  in place, which is what keeps the rest of the file exactly as it was written. */
function stringScalar(map: YAMLMap, key: string): Scalar | null {
  const node = map.get(key, true);
  return isScalar(node) && typeof node.value === "string" ? node : null;
}

/**
 * The source platform whose compose this is: the name a report says, and the
 * networks that belong to the platform rather than to the stack.
 */
export interface SourcePlatformShape {
  name: string;
  networks: readonly string[];
}

export const DOKPLOY_PLATFORM: SourcePlatformShape = {
  name: "Dokploy",
  networks: [DOKPLOY_NETWORK],
};

/**
 * Every top-level network KEY in this compose that resolves to one of the
 * platform's own networks - which is not only the key that spells its name.
 */
export function platformNetworkKeys(
  doc: { networks?: unknown },
  names: readonly string[],
): Set<string> {
  const keys = new Set<string>();
  const wanted = new Set(names.map((n) => n.trim()).filter(Boolean));
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return keys;
  for (const [key, raw] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    // Dokploy's fixed name speaks for itself. Any other name has to say
    // `external:` or point with `name:`: an internal network someone happened to
    // call `coolify` is theirs, not the platform's.
    if (key === DOKPLOY_NETWORK && wanted.has(key)) keys.add(key);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    const ext = n.external;
    const extName =
      ext != null && typeof ext === "object" && !Array.isArray(ext)
        ? (ext as Record<string, unknown>).name
        : null;
    const named =
      (typeof n.name === "string" && wanted.has(n.name.trim())) ||
      (typeof extName === "string" && wanted.has(extName.trim()));
    if (named || (wanted.has(key) && ext === true)) keys.add(key);
  }
  return keys;
}

/** Take those networks off one `networks:` value, in either of its two shapes. */
function stripNetworks(holder: YAMLMap, keys: Set<string>): void {
  const node = holder.get("networks", true);
  if (isSeq(node)) {
    node.items = node.items.filter(
      (entry) => !keys.has(String(isScalar(entry) ? entry.value : entry)),
    );
    if (node.items.length === 0) holder.delete("networks");
  } else if (isMap(node)) {
    for (const key of keys) node.delete(key);
    if (node.items.length === 0) holder.delete("networks");
  }
}

/**
 * Turn the source platform's compose file into a Deplo one. Left alone, a `../`
 * source is not
 * merely wrong - Deplo reads it as climbing OUT of the sandbox, so the stack would
 * demand the host-volumes grant and then bind a path that holds nothing.
 *
 * Edited as a DOCUMENT, so anchors, merge keys, comments and layout come out the
 * way their author wrote them - and an anchor is edited once, for every service
 * that merges it.
 */
export function adaptComposeForDeplo(
  source: string,
  platform: SourcePlatformShape = DOKPLOY_PLATFORM,
): {
  compose: string;
  changes: string[];
} {
  const doc = readComposeDoc(source);
  if (!doc) return { compose: source, changes: [] };
  const root = doc.contents as YAMLMap;

  const changes: string[] = [];
  const keys = platformNetworkKeys(
    { networks: toPlain(root.get("networks")) },
    platform.networks,
  );

  if (keys.size > 0) {
    const declared = root.get("networks", true);
    if (isMap(declared)) {
      for (const key of keys) declared.delete(key);
      if (declared.items.length === 0) root.delete("networks");
    }
    changes.push(
      `${platform.name}'s shared network was removed - Deplo attaches the services to its own.`,
    );
  }

  for (const { map: holder } of serviceLikeMaps(root)) {
    if (keys.size > 0) stripNetworks(holder, keys);

    // The file-mount paths, off both shapes of a volume entry. A SEQUENCE is what
    // tells a service's mounts from the top-level named-volume block.
    const vols = holder.get("volumes", true);
    if (!isSeq(vols)) continue;
    for (const entry of vols.items) {
      if (isScalar(entry) && typeof entry.value === "string") {
        const idx = entry.value.indexOf(":");
        if (idx <= 0) continue;
        const rewritten = deploFilesPath(entry.value.slice(0, idx));
        if (rewritten == null) continue;
        changes.push(
          `${entry.value.slice(0, idx)} now points at Deplo's files directory.`,
        );
        entry.value = `${rewritten}${entry.value.slice(idx)}`;
      } else if (isMap(entry)) {
        const src = stringScalar(entry, "source");
        if (!src) continue;
        const rewritten = deploFilesPath(src.value as string);
        if (rewritten == null) continue;
        changes.push(`${src.value} now points at Deplo's files directory.`);
        src.value = rewritten;
      }
    }
  }

  // The SAME `../files/x` rewrite, everywhere else a compose file can name a file
  // next to itself.
  for (const [where, target] of composeFileRefs(root)) {
    const rewritten = deploFilesPath(target.value as string);
    if (rewritten == null) continue;
    changes.push(
      `${target.value} now points at Deplo's files directory (${where}).`,
    );
    target.value = rewritten;
  }

  if (changes.length === 0) return { compose: source, changes: [] };
  return { compose: String(doc), changes };
}

/**
 * Point an `env_file` at the env file DEPLO writes, when the stack names one it
 * did not bring with it. The rule is deliberately narrow: an entry is retargeted
 * ONLY when the file is not one this app carries.
 */
export function retargetPlatformEnvFiles(
  source: string,
  carried: string[],
): { compose: string; changes: string[] } {
  const doc = readComposeDoc(source);
  if (!doc) return { compose: source, changes: [] };
  const root = doc.contents as YAMLMap;

  const have = new Set(
    carried.map((f) =>
      f
        .trim()
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, ""),
    ),
  );
  const changes: string[] = [];
  const retarget = (value: string): string | null => {
    const named = value.trim().replace(/^\.\/+/, "");
    if (!named || named === ".env") return null;
    // An absolute path or one climbing out is a host path, not the platform's
    // env file - the compose gates decide about those, not this.
    if (named.startsWith("/") || named.split("/").includes("..")) return null;
    if (have.has(named)) return null;
    return "./.env";
  };

  for (const { name: who, map: holder } of serviceLikeMaps(root)) {
    for (const target of envFileScalars(holder)) {
      const next = retarget(target.value as string);
      if (!next) continue;
      changes.push(
        `${who} reads its variables from ${target.value}, which is the file the other platform wrote. It now reads Deplo's own - the values are this app's variables.`,
      );
      target.value = next;
    }
  }

  if (changes.length === 0) return { compose: source, changes: [] };
  return { compose: String(doc), changes };
}

/** A compose document worth rewriting: it parsed, and its root is a mapping. */
function readComposeDoc(source: string): Document | null {
  let doc: Document;
  try {
    doc = yaml.parseDocument(source);
  } catch {
    return null;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  // Re-serializing the document is what loses `UMASK: 022`, so the text is pinned
  // before anything edits it.
  keepAuthoredEnvText(doc);
  return doc;
}

/** A node as plain data, for the readers that want the value and not the node. */
function toPlain(node: unknown): unknown {
  try {
    return (node as { toJSON?: () => unknown } | null)?.toJSON?.() ?? node;
  } catch {
    return null;
  }
}

/** Every `env_file` entry of one service-like map, in all three shapes. */
function envFileScalars(holder: YAMLMap): Scalar[] {
  const out: Scalar[] = [];
  const node = holder.get("env_file", true);
  if (isScalar(node) && typeof node.value === "string") out.push(node);
  else if (isSeq(node))
    for (const entry of node.items) {
      if (isScalar(entry) && typeof entry.value === "string") out.push(entry);
      else if (isMap(entry)) {
        const path = stringScalar(entry, "path");
        if (path) out.push(path);
      }
    }
  return out;
}

/**
 * Every place OUTSIDE `services[].volumes` where a compose file names a file next
 * to itself: the env files, the label files, a build context, and the `secrets` /
 * `configs` blocks.
 */
function composeFileRefs(root: YAMLMap): [string, Scalar][] {
  const out: [string, Scalar][] = [];
  for (const { name: who, map: holder } of serviceLikeMaps(root)) {
    for (const target of envFileScalars(holder))
      out.push([`${who}.env_file`, target]);

    const label = holder.get("label_file", true);
    if (isScalar(label) && typeof label.value === "string")
      out.push([`${who}.label_file`, label]);
    else if (isSeq(label))
      for (const entry of label.items)
        if (isScalar(entry) && typeof entry.value === "string")
          out.push([`${who}.label_file`, entry]);

    const build = holder.get("build", true);
    if (isScalar(build) && typeof build.value === "string")
      out.push([`${who}.build`, build]);
    else if (isMap(build)) {
      const context = stringScalar(build, "context");
      if (context) out.push([`${who}.build`, context]);
    }
  }

  for (const block of ["secrets", "configs"] as const) {
    const declared = root.get(block, true);
    if (!isMap(declared)) continue;
    for (const item of declared.items) {
      if (!isMap(item.value)) continue;
      const file = stringScalar(item.value, "file");
      if (file)
        out.push([`${block}.${String((item.key as Scalar).value)}`, file]);
    }
  }
  return out;
}

/**
 * Where the other platform keeps a stack's own files. Dokploy writes them beside
 * the compose (`../files/x`); Coolify writes them under its data directory.
 */
const PLATFORM_FILES_RE = [
  /^\.\.\/files(?:\/(.*))?$/,
  /^\/data\/coolify\/(?:applications|services)\/[^/]+(?:\/(.*))?$/,
];

/**
 * The source platform's own files directory as Deplo spells it, or null when the
 * source is not one (a named volume, a real host path, an escape to somewhere else).
 */
export function deploFilesPath(source: string): string | null {
  const s = source.trim();
  for (const re of PLATFORM_FILES_RE) {
    const m = re.exec(s);
    if (!m) continue;
    const rest = (m[1] ?? "").replace(/^\/+/, "");
    return rest ? `./${rest}` : ".";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Build settings                                                      */
/* ------------------------------------------------------------------ */

const BUILD_METHOD: Record<string, BuildMethod> = {
  dockerfile: "dockerfile",
  nixpacks: "nixpacks",
  railpack: "railpack",
  static: "static",
  // Neither buildpack family has a deplo equivalent. Nixpacks is the closest
  // thing: an auto-detecting builder that reads the same repos. Noted, never
  // silent - a Heroku buildpack with a custom `bin/compile` will not survive it.
  heroku_buildpacks: "nixpacks",
  paketo_buildpacks: "nixpacks",
};

/**
 * Dokploy's per-service build fields → deplo's `BuildConfig`.
 */
export function mapBuildSettings(
  app: DokployApplication,
): Mapped<Partial<BuildConfig>> {
  const notes: string[] = [];
  const buildMethod = BUILD_METHOD[app.buildType] ?? "nixpacks";
  if (
    app.buildType === "heroku_buildpacks" ||
    app.buildType === "paketo_buildpacks"
  )
    notes.push(
      `Built with ${app.buildType.replace("_", " ")} on Dokploy. Set to Nixpacks - check the build.`,
    );

  const build: Partial<BuildConfig> = { buildMethod };
  const methodSettings: BuildConfig["methodSettings"] = {};

  // ONLY the settings the chosen builder reads.
  if (buildMethod === "dockerfile") {
    if (app.dockerfile?.trim())
      methodSettings.dockerfilePath = app.dockerfile.trim();
    if (app.dockerContextPath?.trim())
      methodSettings.dockerContextPath = app.dockerContextPath.trim();
    if (app.dockerBuildStage?.trim())
      methodSettings.dockerBuildStage = app.dockerBuildStage.trim();
  }
  if (buildMethod === "railpack" && app.railpackVersion?.trim())
    methodSettings.railpackVersion = app.railpackVersion.trim();

  const publish = app.publishDirectory?.trim();
  if (buildMethod === "static") {
    if (publish) build.outputDirectory = publish;
    if (app.isStaticSpa) methodSettings.staticSinglePageApp = true;
  } else if (buildMethod === "nixpacks" && publish) {
    methodSettings.nixpacksPublishDirectory = publish;
  }
  if (Object.keys(methodSettings).length > 0)
    build.methodSettings = methodSettings;

  const root = buildPathFor(app);
  if (root) build.rootDirectory = root;

  // Dokploy's `command` overrides the container's command; deplo's closest field
  // is the builder's start command. Same intent, different layer for a
  // Dockerfile build (where deplo leaves CMD alone), hence the note.
  const command = app.command?.trim();
  if (command) {
    build.startCommand = command;
    if (buildMethod === "dockerfile")
      notes.push(
        `Container command "${truncate(command, 80)}" became the start command. A Dockerfile keeps its own CMD.`,
      );
  }

  if ((app.replicas ?? 1) > 1)
    notes.push(
      `Runs ${app.replicas} replicas on Dokploy. Deplo runs one container per app, so it arrives as one.`,
    );

  return { value: build, notes };
}

/** The repo subdirectory to build from, whichever provider the app uses. */
function buildPathFor(app: DokployApplication | DokployCompose): string | null {
  const candidates = [
    (app as DokployApplication).buildPath,
    (app as DokployApplication).gitlabBuildPath,
    (app as DokployApplication).giteaBuildPath,
    (app as DokployApplication).bitbucketBuildPath,
    (app as DokployApplication).customGitBuildPath,
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && v !== "/" && v !== "./") return v;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Resource limits                                                     */
/* ------------------------------------------------------------------ */

const MEM_UNITS: Record<string, number> = {
  b: 1 / (1024 * 1024),
  k: 1 / 1024,
  kb: 1 / 1024,
  ki: 1 / 1024,
  kib: 1 / 1024,
  m: 1,
  mb: 1,
  mi: 1,
  mib: 1,
  g: 1024,
  gb: 1024,
  gi: 1024,
  gib: 1024,
};

/** Docker's memory grammar (`512m`, `1g`, `1.5Gi`, or a bare byte count) → MiB. */
export function parseMemoryMb(raw: string | null | undefined): number | null {
  const s = raw?.trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  // A bare number in this column is bytes, which is what Docker's API takes and
  // what Dokploy's own forms sometimes hold.
  const factor = unit ? MEM_UNITS[unit] : 1 / (1024 * 1024);
  if (factor === undefined) return null;
  const mb = Math.round(n * factor);
  return mb >= 1 ? mb : null;
}

/**
 * Dokploy's CPU limit → deplo's milli-CPUs.
 *
 * ponytail: the column is free text and holds two conventions - cores as a
 * decimal (`0.5`, what Dokploy's form asks for) and nano-CPUs (`500000000`, what
 * Docker's API takes). Split on 1000, because a 1000-core limit is not a thing
 * anyone types and half a nano-CPU is not either. If a third convention ever
 * shows up, this is the line to change.
 */
export function parseCpuMilli(raw: string | null | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  const milli = n > 1000 ? Math.round(n / 1_000_000) : Math.round(n * 1000);
  return milli >= 10 ? milli : null;
}

/** Dokploy's four limit columns → deplo's `resource_*`. Null when nothing was set. */
export function mapResources(row: {
  memoryLimit?: string | null;
  memoryReservation?: string | null;
  cpuLimit?: string | null;
  cpuReservation?: string | null;
}): Mapped<ResourceInput | null> {
  const notes: string[] = [];
  const memoryMb = parseMemoryMb(row.memoryLimit);
  const memoryReservationMb = parseMemoryMb(row.memoryReservation);
  const cpuMilli = parseCpuMilli(row.cpuLimit);

  for (const [label, raw, parsed] of [
    ["Memory limit", row.memoryLimit, memoryMb],
    ["Memory reservation", row.memoryReservation, memoryReservationMb],
    ["CPU limit", row.cpuLimit, cpuMilli],
  ] as const)
    if (raw?.trim() && parsed == null)
      notes.push(
        `${label} "${raw.trim()}" is not a value Deplo can read - set it by hand.`,
      );

  // Dokploy's cpuReservation is a swarm scheduling hint with no deplo column.
  if (row.cpuReservation?.trim())
    notes.push(
      `CPU reservation "${row.cpuReservation.trim()}" is a Swarm placement hint. Deplo has no equivalent, so it is not imported.`,
    );

  // A reservation above the limit is what deplo's own validator refuses; drop it
  // rather than lose the limit too.
  const reservation =
    memoryReservationMb != null &&
    memoryMb != null &&
    memoryReservationMb > memoryMb
      ? null
      : memoryReservationMb;
  if (reservation !== memoryReservationMb)
    notes.push(
      "Memory reservation is above the limit on Dokploy - not imported.",
    );

  if (memoryMb == null && reservation == null && cpuMilli == null)
    return { value: null, notes };
  return {
    value: { memoryMb, memoryReservationMb: reservation, cpuMilli },
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Icon                                                                */
/* ------------------------------------------------------------------ */

/**
 * The service's icon, carried over as-is. Those come back `null` rather than
 * throwing: an icon is decoration, and losing it must never be the reason a
 * service fails to import.
 */
export function mapLogo(icon: string | null | undefined): string | null {
  const value = icon?.trim();
  if (!value) return null;
  return isValidLogoValue(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* Git source                                                          */
/* ------------------------------------------------------------------ */

/** A source deplo can deploy, or null when the app has to be rebuilt by hand. */
export type MappedSource =
  | { kind: "git"; repo: GitRepo }
  | { kind: "docker-image"; image: string }
  | { kind: "none" };

const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

/**
 * Where the app's code comes from.
 */
export function mapSource(app: DokployApplication): Mapped<MappedSource> {
  const notes: string[] = [];

  if (app.sourceType === "docker") {
    const image = app.dockerImage?.trim();
    if (!image) {
      notes.push("Docker source with no image set on Dokploy - pick an image.");
      return { value: { kind: "none" }, notes };
    }
    if (!IMAGE_REF_RE.test(image)) {
      notes.push(
        `Image reference "${truncate(image, 80)}" is not one Deplo accepts - set it by hand.`,
      );
      return { value: { kind: "none" }, notes };
    }
    // A private pull can be configured two ways over there: a registry ENTITY, or a
    // username/password/URL typed straight onto the application (`saveDockerProvider`).
    if (app.registryId || app.registry || app.username || app.registryUrl)
      notes.push(
        "From a private registry. Add it under Registries and reselect it - Dokploy never exposes the password.",
      );
    // A registry running ON the source host. The reference is perfectly valid over
    // there and means nothing here, and the failure it produces later ("pull
    // access denied") points at the image rather than at the move.
    if (/^(localhost|127\.0\.0\.1|::1|host\.docker\.internal)[:/]/i.test(image))
      notes.push(
        `${image} is in a registry on the Dokploy machine. Push it somewhere Deplo can reach, or build from source.`,
      );
    return { value: { kind: "docker-image", image }, notes };
  }

  if (app.sourceType === "drop") {
    notes.push(
      "Its code is an archive somebody uploaded to Dokploy, and the API will not hand the file over. Upload it again here.",
    );
    return { value: { kind: "none" }, notes };
  }

  const repo = cloneTarget(app);
  if (!repo) {
    notes.push(
      "Could not work out the repository from Dokploy - set the source by hand.",
    );
    return { value: { kind: "none" }, notes };
  }

  if (app.customGitSSHKeyId)
    notes.push(
      "Clones over SSH with a key stored in Dokploy. Deplo clones over https, so add a git connection for this host.",
    );
  else
    notes.push(
      `${repo.repo} arrives with no credential. Attach a git connection to deploy it - that also turns on auto-deploy.`,
    );

  return {
    value: {
      kind: "git",
      repo: {
        ...repo,
        triggerType: app.triggerType === "tag" ? "tag" : "push",
        watchPaths: (app.watchPaths ?? []).filter((p) => p.trim()),
        submodules: app.enableSubmodules === true,
      },
    },
    notes,
  };
}

/** The `owner/name`, branch and https URL for whichever provider is configured. */
export function cloneTarget(
  app: DokployApplication | DokployCompose,
): GitRepo | null {
  const a = app as DokployApplication;
  // Origin AND path: a self-hosted GitLab or Gitea behind a reverse proxy lives at
  // `https://acme.com/gitlab`, and dropping the prefix clones a 404.
  const host = (raw: string | null | undefined, fallback: string): string => {
    const v = raw?.trim();
    if (!v) return fallback;
    try {
      const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    } catch {
      return fallback;
    }
  };

  switch (app.sourceType) {
    case "github": {
      if (!a.owner || !a.repository) return null;
      return {
        provider: "github",
        url: `https://github.com/${a.owner}/${a.repository}.git`,
        repo: `${a.owner}/${a.repository}`,
        branch: a.branch?.trim() || "main",
      };
    }
    case "gitlab": {
      // `gitlabPathNamespace` is the FULL project path, not the namespace its name
      // suggests: Dokploy clones `<host>/<gitlabPathNamespace>.git`. Appending the
      // repository to it produced `group/repo/repo.git`, a 404 on every app.
      const owner = a.gitlabOwner?.trim();
      const repository = a.gitlabRepository?.trim();
      const path =
        a.gitlabPathNamespace?.trim() ||
        (owner && repository ? `${owner}/${repository}` : "");
      if (!path) return null;
      const origin = host(a.gitlab?.gitlabUrl, "https://gitlab.com");
      return {
        provider: "gitlab",
        url: `${origin}/${path}.git`,
        repo: path,
        branch: a.gitlabBranch?.trim() || "main",
      };
    }
    case "gitea": {
      if (!a.giteaOwner || !a.giteaRepository) return null;
      const origin = host(a.gitea?.giteaUrl, "https://gitea.com");
      return {
        provider: "gitea",
        url: `${origin}/${a.giteaOwner}/${a.giteaRepository}.git`,
        repo: `${a.giteaOwner}/${a.giteaRepository}`,
        branch: a.giteaBranch?.trim() || "main",
      };
    }
    case "bitbucket": {
      const slug =
        a.bitbucketRepositorySlug?.trim() || a.bitbucketRepository?.trim();
      if (!a.bitbucketOwner || !slug) return null;
      return {
        provider: "bitbucket",
        url: `https://bitbucket.org/${a.bitbucketOwner}/${slug}.git`,
        repo: `${a.bitbucketOwner}/${slug}`,
        branch: a.bitbucketBranch?.trim() || "main",
      };
    }
    case "git": {
      const url = a.customGitUrl?.trim();
      if (!url) return null;
      return {
        provider: "git",
        url,
        repo: repoNameFromUrl(url),
        branch: a.customGitBranch?.trim() || "main",
      };
    }
    default:
      return null;
  }
}

/** `owner/name` out of any clone URL, https or scp-style. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^[^/:]+[:/]/, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cleaned;
}

/* ------------------------------------------------------------------ */
/* Domains                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hostnames that only ever meant "the box this used to run on": Dokploy's
 * generated `traefik.me` names and the wildcard-DNS services that encode an IP.
 */
const THROWAWAY_HOST_RE = /(^|\.)(traefik\.me|sslip\.io|nip\.io|localhost)$/i;

export function isThrowawayHost(host: string): boolean {
  return THROWAWAY_HOST_RE.test(host.trim().toLowerCase());
}

export interface MappedDomain {
  /**
   * The hostname on the SOURCE. When {@link generated} is true this name does
   * NOT come across - it is kept only so the report can say what became what.
   */
  host: string;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
  certProvider: CertProvider;
  entrypoint: DomainEntrypoint;
  service: string | null;
  /**
   * The source host was the other platform's own THROWAWAY address - a
   * `*.sslip.io` / `*.traefik.me` / `*.nip.io` name with its server's IP baked in.
   */
  generated: boolean;
}

/**
 * The domains worth importing, in Dokploy's own order (the first survivor becomes
 * deplo's primary).
 */
export function mapDomains(
  domains: DokployDomain[] | null | undefined,
  opts: { isCompose: boolean; fallbackPort?: number | null },
): Mapped<MappedDomain[]> {
  const notes: string[] = [];
  const out: MappedDomain[] = [];
  for (const d of domains ?? []) {
    const host = d.host?.trim().toLowerCase();
    if (!host) continue;
    if (d.domainType === "preview") continue;
    if (d.enabled === false) continue;

    let certProvider: CertProvider = "none";
    if (d.certificateType === "letsencrypt") certProvider = "letsencrypt";
    else if (d.certificateType === "custom")
      notes.push(
        `${host} uses a custom certificate resolver on Dokploy. Imported without a certificate - pick one in Domains.`,
      );

    const path = (d.path ?? "/").trim();
    const pathPrefix = path === "/" ? "" : path;
    // Dokploy can rewrite the path on the way to the container.
    const internal = (d.internalPath ?? "").trim();
    if (internal && internal !== "/")
      notes.push(
        `${host} rewrites the path to ${internal} before the container sees it. Deplo forwards the path as it is (or strips the prefix), so the app now receives ${pathPrefix || "/"} - check that it serves that.`,
      );
    // Deplo has two entrypoints, web and websecure. A route on any other one
    // lands on websecure, and that has to be said rather than discovered.
    const custom = (d.customEntrypoint ?? "").trim();
    if (custom && custom !== "web" && custom !== "websecure")
      notes.push(
        `${host} answered on Dokploy's "${custom}" entrypoint. Deplo has only web and websecure, so it comes across on websecure - open that port on this app if it needs one.`,
      );
    const port = d.port ?? opts.fallbackPort ?? null;
    if (opts.isCompose && port == null)
      notes.push(
        `${host} has no container port set - Deplo needs one for a compose stack.`,
      );

    out.push({
      host,
      port,
      pathPrefix,
      stripPrefix: pathPrefix ? d.stripPath === true : false,
      certProvider,
      entrypoint:
        d.https === false && certProvider === "none" ? "web" : "websecure",
      service: opts.isCompose ? d.serviceName?.trim() || null : null,
      generated: isThrowawayHost(host),
    });
  }
  return { value: out, notes };
}

/* ------------------------------------------------------------------ */
/* Mounts                                                             */
/* ------------------------------------------------------------------ */

export interface MappedMounts {
  /**
   * Config files that must exist in the stack's files dir, with the container path
   * Dokploy mounted each one at (empty for a compose stack's, whose YAML does the
   * binding itself).
   */
  files: { filePath: string; content: string; mountPath: string }[];
  /** Named volumes and host binds, for `setAppVolumes`. */
  volumes: Omit<VolumeMount, "id">[];
}

/** lowercase-kebab, which is what deplo requires of a volume label. */
export function volumeLabel(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return cleaned || fallback;
}

/**
 * The file's name in the app's files dir, taken from the only address a mount
 * with no `filePath` has: the path it is mounted at inside the container
 * ("/etc/nginx/nginx.conf" -> "nginx.conf").
 */
function fileNameFromMountPath(mountPath: string): string {
  const last = mountPath
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .pop();
  return last ?? "";
}

/**
 * `base`, or the first `<stem>-<n>.<ext>` nobody has taken yet.
 */
function uniqueFilePath(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const slash = base.lastIndexOf("/") + 1;
  const dot = base.indexOf(".", slash + 1);
  const stem = dot < 0 ? base : base.slice(0, dot);
  const ext = dot < 0 ? "" : base.slice(dot);
  let name = base;
  for (let i = 2; ; i++) {
    name = `${stem}-${i}${ext}`;
    if (!used.has(name)) break;
  }
  used.add(name);
  return name;
}

/**
 * Dokploy's three mount kinds -> deplo's writers.
 */
export function mapMounts(
  mounts: DokployMount[] | null | undefined,
  opts: { isCompose: boolean },
): Mapped<MappedMounts> {
  const notes: string[] = [];
  const files: MappedMounts["files"] = [];
  const volumes: Omit<VolumeMount, "id">[] = [];
  const used = new Set<string>();
  const usedFiles = new Set<string>();

  for (const m of mounts ?? []) {
    const mountPath = m.mountPath?.trim();
    if (m.type === "file") {
      // Deplo owns the whole files dir, so only the file's own name travels -
      // never Dokploy's `../files/` prefix and never an absolute path.
      const declared = (m.filePath ?? "")
        .trim()
        .replace(/^\.\/+/, "")
        .replace(/^\/+|\/+$/g, "");
      const wanted = declared || fileNameFromMountPath(mountPath ?? "");
      if (!wanted || wanted.split("/").includes("..")) {
        notes.push(
          "A file mount has no usable path on Dokploy - not imported.",
        );
        continue;
      }
      const name = uniqueFilePath(wanted, usedFiles);
      if (name !== wanted)
        notes.push(
          `Two file mounts are both called ${wanted}, so one of them is ${name} in this app's Files.`,
        );
      files.push({
        filePath: name,
        content: m.content ?? "",
        mountPath: mountPath ?? "",
      });
      // Only an application needs the pairing: a compose stack already binds the
      // file in its own YAML, and a second mount for it would fight that one.
      if (!opts.isCompose && mountPath)
        volumes.push({
          type: "app",
          name: volumeLabel(name, "file"),
          projectPath: name,
          mountPath,
          readOnly: false,
        });
      continue;
    }
    if (!mountPath) {
      notes.push("A mount has no container path on Dokploy - not imported.");
      continue;
    }
    if (m.type === "volume") {
      const base = volumeLabel(
        m.volumeName ?? "",
        volumeLabel(mountPath, "data"),
      );
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
      used.add(name);
      volumes.push({ type: "named", name, mountPath, readOnly: false });
      continue;
    }
    // bind
    const hostPath = m.hostPath?.trim();
    if (!hostPath) {
      notes.push(
        `Bind mount at ${mountPath} has no host path on Dokploy - not imported.`,
      );
      continue;
    }
    volumes.push({
      type: "host",
      name: volumeLabel(mountPath, "bind"),
      hostPath,
      mountPath,
      readOnly: false,
    });
  }

  return { value: { files, volumes }, notes };
}

/* ------------------------------------------------------------------ */
/* Databases                                                           */
/* ------------------------------------------------------------------ */

const DB_ENGINE: Record<string, DatabaseType> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongodb",
  redis: "redis",
  // Coolify's own spellings. keydb and dragonfly speak RESP but store their own
  // formats, and libsql has no twin at all: all three answer null.
  postgresql: "postgres",
  mongodb: "mongodb",
  clickhouse: "clickhouse",
};

/**
 * The deplo engine for one of the source platform's database tables, or null when
 * there is none (libsql, keydb, dragonfly).
 */
export function deploEngineFor(kind: string): DatabaseType | null {
  return DB_ENGINE[kind] ?? null;
}

export interface MappedDatabase {
  type: DatabaseType;
  name: string;
  /** The source image's tag, or "latest" when it had none. Display only - the
   *  image a database actually runs is {@link MappedDatabase.customImage}. */
  version: string;
  username: string | null;
  dbName: string | null;
  password: string | null;
  exposedPort: number | null;
  /** The image Dokploy ran, ALWAYS kept verbatim - see `mapDatabase`. */
  customImage: string;
  /**
   * The start command Dokploy overrode, or null.
   */
  command: string | null;
  /** The engine's config files, in deplo's shape. Almost always empty. */
  mounts: { filePath: string; content: string; mountPath: string }[];
}

/** The version tag out of an image ref, ignoring a registry port. */
export function imageTag(image: string | null | undefined): string | null {
  const s = image?.trim();
  if (!s) return null;
  const at = s.indexOf("@");
  const ref = at === -1 ? s : s.slice(0, at);
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon === -1 || colon < slash) return null;
  const tag = ref.slice(colon + 1).trim();
  return /^[A-Za-z0-9._-]+$/.test(tag) ? tag : null;
}

/** The repository half of an image ref (`bitnami/postgresql:15` → `bitnami/postgresql`). */
function imageRepo(image: string | null | undefined): string | null {
  const s = image?.trim();
  if (!s) return null;
  const tag = imageTag(s);
  return tag ? s.slice(0, s.length - tag.length - 1) : s;
}

/**
 * One of Dokploy's five database tables → `createDatabase` input.
 */
export function mapDatabase(
  kind: DokployDbKind,
  row: DokployDatabase,
): Mapped<MappedDatabase | null> {
  const notes: string[] = [];
  const type = deploEngineFor(kind);
  if (!type) {
    notes.push(`${row.name}: Deplo has no ${kind} engine - not imported.`);
    return { value: null, notes };
  }

  // The source's EXACT image is kept, canonical or not - deplo never re-derives one
  // here. Data must be reopened by the binary that wrote it.
  const customImage = row.dockerImage?.trim() || `${kind}:latest`;
  const tag = imageTag(customImage);
  const version = tag ?? "latest";
  if (!tag)
    notes.push(
      `Dokploy runs ${customImage} with no version pinned, so what it resolves to can change under the data. Pin a version under Advanced.`,
    );
  const repo = imageRepo(row.dockerImage);
  const canonical =
    !repo ||
    repo === kind ||
    repo === type ||
    repo === `library/${kind}` ||
    (kind === "mongo" && repo === "mongo");
  if (!canonical)
    notes.push(
      `Runs ${customImage} on Dokploy instead of a plain ${type}. Kept as it is - check that it starts.`,
    );

  // A multi-line command is not something Deplo's column takes (it renders as a
  // quoted scalar in the compose), so that one still has to be retyped.
  const command = row.command?.trim() || null;
  if (command && /[\r\n\t]/.test(command))
    notes.push(
      `Custom start command on Dokploy ("${truncate(command, 60)}") spans more than one line - set it under Advanced if you still need it.`,
    );
  // Dokploy models a database's own DATA volume as a mount row, so counting every
  // mount announced "extra files that are not imported" about the one thing the Data
  // step exists to copy - on every single database.
  const mapped = mapMounts(
    (row.mounts ?? []).filter((m) => m.type === "file"),
    { isCompose: false },
  );
  notes.push(...mapped.notes);
  const binds = (row.mounts ?? []).filter((m) => m.type === "bind");
  if (binds.length > 0)
    notes.push(
      `This database bind-mounts ${binds.length === 1 ? "a folder" : "folders"} from its host on Dokploy (${binds
        .map((m) => m.hostPath || m.mountPath)
        .join(
          ", ",
        )}). Deplo databases have no host mounts - move what is in there another way.`,
    );

  // mysql and mariadb keep TWO credentials on Dokploy - an application user and root
  // - while deplo models ONE and uses it for both.
  const envKeys = parseEnvBlob(row.env).map((e) => e.key);
  if (envKeys.length > 0)
    notes.push(
      `Carried ${envKeys.length} environment variable(s) on Dokploy (${envKeys.join(", ")}). A Deplo database has none - fold what matters into the image, the start command or a config file under Settings -> Advanced.`,
    );

  const rootPassword =
    (type === "mysql" || type === "mariadb") && row.databaseRootPassword?.trim()
      ? row.databaseRootPassword.trim()
      : null;
  if (rootPassword && rootPassword !== row.databasePassword?.trim())
    notes.push(
      `Connects as root, because that is the login Deplo's own backups and console use and the copied data keeps Dokploy's users. "${row.databaseUser?.trim() || "the application user"}" still works from inside the database.`,
    );

  return {
    value: {
      type,
      // The tree's row has no name for a database (only its id), so a caller that
      // maps one straight from `project.all` would create "" here. The detail row
      // always has it; the fallback keeps this pure function total either way.
      name: row.name?.trim() || "database",
      version,
      username: rootPassword ? "root" : row.databaseUser?.trim() || null,
      dbName: row.databaseName?.trim() || null,
      password: rootPassword ?? (row.databasePassword?.trim() || null),
      // A real published port or nothing.
      exposedPort:
        typeof row.externalPort === "number" && row.externalPort > 0
          ? row.externalPort
          : null,
      customImage,
      command: command && !/[\r\n\t]/.test(command) ? command : null,
      // Every file mount Dokploy had, named and pathed the way deplo stores
      // them. A file with no container path cannot be mounted anywhere and is
      // dropped by `mapMounts` with a note of its own.
      mounts: mapped.value.files.filter((f) => f.mountPath),
    },
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* The data cutover: pairing volumes                                   */
/* ------------------------------------------------------------------ */

/** One named volume a container is using, on either side. */
export interface NamedVolume {
  /** The volume's real name on the host. */
  name: string;
  /** Where it is mounted INSIDE the container - the only identity the two
   *  platforms share, since neither's volume names mean anything to the other. */
  mountPath: string;
}

/** A source volume matched to the deplo volume it should be copied into. */
export interface VolumePair {
  sourceVolume: string;
  targetVolume: string;
  /** The container path, when both sides agree on it. */
  mountPath: string;
  /** Set when the pairing was made on something weaker than an equal path. */
  note: string | null;
}

/** Trailing slashes and a missing leading slash are not a difference. */
function normalizePath(p: string): string {
  const s = p.trim().replace(/\/+$/, "");
  return s.startsWith("/") ? s : `/${s}`;
}

/**
 * The named volumes a `docker inspect` says a container is using.
 */
export function sourceVolumesFrom(inspect: {
  Mounts?: {
    Type?: string;
    Name?: string;
    /** Present on a bind mount; ignored, but part of what docker sends. */
    Source?: string;
    Destination?: string;
  }[];
}): NamedVolume[] {
  const out: NamedVolume[] = [];
  const seen = new Set<string>();
  for (const m of inspect.Mounts ?? []) {
    if (m.Type !== "volume") continue;
    const name = m.Name?.trim();
    const dest = m.Destination?.trim();
    if (!name || !dest || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, mountPath: normalizePath(dest) });
  }
  // Drop a mount whose path is an ANCESTOR of another mount's.
  return out.filter(
    (v) => !out.some((o) => o !== v && isUnderPath(o.mountPath, v.mountPath)),
  );
}

/** One host directory a container mounts: where it is on the host, and where the
 *  container sees it. The bind-mount counterpart of a NamedVolume. */
export interface HostMount {
  hostPath: string;
  mountPath: string;
}

/**
 * The BIND MOUNTS a `docker inspect` says a container is using.
 */
export function sourceBindMountsFrom(inspect: {
  Mounts?: { Type?: string; Source?: string; Destination?: string }[];
}): HostMount[] {
  const out: HostMount[] = [];
  const seen = new Set<string>();
  for (const m of inspect.Mounts ?? []) {
    if (m.Type !== "bind") continue;
    const hostPath = m.Source?.trim();
    const dest = m.Destination?.trim();
    if (!hostPath || !dest || seen.has(dest)) continue;
    seen.add(dest);
    out.push({
      hostPath: normalizePath(hostPath),
      mountPath: normalizePath(dest),
    });
  }
  return out;
}

/** The bind mounts a Dokploy service DECLARES - the fallback for a stopped service,
 *  exactly like `declaredSourceVolumes` is for its named ones. */
export function declaredSourceBindMounts(
  mounts?:
    | {
        type?: string | null;
        hostPath?: string | null;
        mountPath?: string | null;
      }[]
    | null,
): HostMount[] {
  const out: HostMount[] = [];
  const seen = new Set<string>();
  for (const m of mounts ?? []) {
    if (m?.type !== "bind") continue;
    const hostPath = m.hostPath?.trim();
    const dest = m.mountPath?.trim();
    if (!hostPath || !dest || seen.has(dest)) continue;
    seen.add(dest);
    out.push({
      hostPath: normalizePath(hostPath),
      mountPath: normalizePath(dest),
    });
  }
  return out;
}

/**
 * Host paths that hold no DATA: a socket the runtime owns (`/var/run/docker.sock`
 * above all) and the kernel's pseudo-filesystems. The agent refuses to read one as
 * a directory, and the refusal used to reach the report as a lost volume.
 */
const NOT_DATA_HOST_PATH = /^\/(proc|sys|dev)(\/|$)|\.sock$/;

/**
 * Match every source bind mount to the deplo host mount that should receive it.
 */
export function pairHostMounts(
  source: HostMount[],
  target: HostMount[],
): { sourcePath: string; targetPath: string; mountPath: string }[] {
  const out: { sourcePath: string; targetPath: string; mountPath: string }[] =
    [];
  for (const s of source) {
    if (NOT_DATA_HOST_PATH.test(s.hostPath)) continue;
    const hit = target.find((t) => t.mountPath === s.mountPath);
    if (!hit) continue;
    out.push({
      sourcePath: s.hostPath,
      targetPath: hit.hostPath,
      mountPath: s.mountPath,
    });
  }
  return out;
}

/** Docker names an anonymous volume with its own 64-hex id. Nobody chose it, so
 *  there is never a volume on the other side that corresponds to it. */
function isAnonymousVolume(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

/** Is `child` strictly inside `parent`? (`/a/b` is under `/a`, `/ab` is not.) */
function isUnderPath(child: string, parent: string): boolean {
  return parent !== "/" ? child.startsWith(`${parent}/`) : child !== "/";
}

/**
 * The volumes a Dokploy service DECLARES, for when there is no container to
 * inspect. Dokploy's own API still answers with the mounts it declared, so that is
 * the fallback.
 */
export function declaredSourceVolumes(input: {
  kind: string;
  appName: string;
  mounts?:
    | {
        type?: string | null;
        volumeName?: string | null;
        mountPath?: string | null;
      }[]
    | null;
  composeFile?: string | null;
}): NamedVolume[] {
  const out: NamedVolume[] = [];
  const seen = new Set<string>();
  const push = (name: string, mountPath: string) => {
    if (!name || !mountPath || seen.has(name)) return;
    seen.add(name);
    out.push({ name, mountPath: normalizePath(mountPath) });
  };

  for (const m of input.mounts ?? [])
    if (m?.type === "volume")
      push(m.volumeName?.trim() ?? "", m.mountPath?.trim() ?? "");

  if (input.kind === "compose" && input.appName.trim())
    for (const v of composeVolumeMounts(input.composeFile ?? ""))
      push(`${input.appName.trim()}_${v.name}`, v.mountPath);

  return out;
}

/**
 * Match every source volume to the deplo volume that should receive it.
 */
export function pairVolumes(
  source: NamedVolume[],
  target: NamedVolume[],
  opts: { singleData?: boolean } = {},
): Mapped<VolumePair[]> {
  const notes: string[] = [];
  const pairs: VolumePair[] = [];
  const takenTarget = new Set<string>();

  for (const s of source) {
    const hit = target.find(
      (t) => !takenTarget.has(t.name) && t.mountPath === s.mountPath,
    );
    if (hit) {
      takenTarget.add(hit.name);
      pairs.push({
        sourceVolume: s.name,
        targetVolume: hit.name,
        mountPath: s.mountPath,
        note: null,
      });
    }
  }

  if (
    pairs.length === 0 &&
    opts.singleData &&
    source.length === 1 &&
    target.length === 1
  ) {
    pairs.push({
      sourceVolume: source[0].name,
      targetVolume: target[0].name,
      mountPath: target[0].mountPath,
      note:
        `The data directory moved: Dokploy mounted it at ${source[0].mountPath}, Deplo mounts ${target[0].mountPath}. ` +
        "The copy is still the right one - one data volume on each side, and Deplo pins the engine's data path to where it mounts it.",
    });
  }

  for (const s of source)
    // An anonymous volume left over is not news: the image asked for it, nobody named
    // it, and nothing on this side could ever correspond to it.
    if (
      !pairs.some((p) => p.sourceVolume === s.name) &&
      !isAnonymousVolume(s.name)
    )
      notes.push(
        `${s.name} is mounted at ${s.mountPath} on Dokploy, but no volume of this app mounts that path.`,
      );
  for (const t of target)
    if (!pairs.some((p) => p.targetVolume === t.name))
      notes.push(
        `${t.name} (${t.mountPath}) stays empty - nothing on Dokploy is mounted there.`,
      );

  return { value: pairs, notes };
}

/**
 * The on-disk name of one of an app's volumes.
 */
export function deploVolumeName(
  slug: string,
  alias: string,
  managed: boolean,
): string {
  return managed ? `deplo-${slug}-${alias}` : `deplo-${slug}_${alias}`;
}

/** The data volume of a Deplo database, whose stack slug is its host name. */
export function deploDatabaseVolumeName(host: string): string {
  return `deplo-${host}_${host}-data`;
}

/**
 * The volumes a compose file declares, with the path each is mounted at.
 */
export function composeVolumeMounts(compose: string): NamedVolume[] {
  let doc: {
    volumes?: unknown;
    services?: Record<string, { volumes?: unknown }>;
  } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return [];
  }
  const declared = doc?.volumes;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return [];
  const aliases = new Set(Object.keys(declared as Record<string, unknown>));
  const out: NamedVolume[] = [];
  const seen = new Set<string>();

  for (const svc of Object.values(doc?.services ?? {})) {
    const mounts = svc?.volumes;
    if (!Array.isArray(mounts)) continue;
    for (const raw of mounts) {
      let alias: string | undefined;
      let dest: string | undefined;
      if (typeof raw === "string") {
        const [src, target] = raw.split(":");
        alias = src?.trim();
        dest = target?.trim();
      } else if (raw && typeof raw === "object") {
        const m = raw as { type?: string; source?: string; target?: string };
        if (m.type && m.type !== "volume") continue;
        alias = m.source?.trim();
        dest = m.target?.trim();
      }
      if (!alias || !dest || !aliases.has(alias) || seen.has(alias)) continue;
      seen.add(alias);
      out.push({ name: alias, mountPath: normalizePath(dest) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

/** Cut a value quoted back at the user. No trailing marker: an ellipsis is
 *  banned from Deplo's copy, and the string is quoted so the cut is visible. */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Published host ports on an application, which deplo does not do for apps. */
export function portNotes(app: DokployApplication): string[] {
  const ports = app.ports ?? [];
  if (ports.length === 0) return [];
  const list = ports
    .map(
      (p) =>
        `${p.publishedPort}->${p.targetPort}${p.protocol ? `/${p.protocol}` : ""}`,
    )
    .join(", ");
  return [
    `Published host ports on Dokploy (${list}). Deplo routes apps through its proxy instead - use a domain, or a compose stack if the port must be published.`,
  ];
}

/** Everything else on a Dokploy service with no deplo column at all. */
export function unsupportedNotes(app: DokployApplication): string[] {
  const notes: string[] = [];
  if ((app.redirects ?? []).length > 0)
    notes.push(
      `${app.redirects!.length} redirect rule(s) on Dokploy - Deplo has no redirect list, use a domain per host.`,
    );
  // Swarm's own service spec.
  const swarm = (
    [
      ["healthCheckSwarm", "a health check"],
      ["placementSwarm", "placement constraints"],
      ["labelsSwarm", "service labels"],
      ["ulimitsSwarm", "ulimits"],
    ] as const
  ).filter(([key]) => hasSwarmValue(app[key]));
  if (swarm.length > 0)
    notes.push(
      `Swarm settings on Dokploy (${swarm.map(([, label]) => label).join(", ")}) have no equivalent here - Deplo runs one container per app through compose.`,
    );
  return notes;
}

/** A swarm column Dokploy actually filled in (it stores `null` or `{}` otherwise). */
function hasSwarmValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "" && v.trim() !== "{}";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return false;
}

/* ------------------------------------------------------------------ */
/* A compose service that is really one app                            */
/* ------------------------------------------------------------------ */

/** What a git-backed compose turns out to be, when it is an app in disguise. */
export interface ComposeRepoApp {
  /** The one service's key, for the note that explains what happened. */
  service: string;
  /** Path to a Dockerfile relative to the repo, when the build names one. */
  dockerfilePath?: string;
  /** The build context, when it is not the repo root. */
  dockerContextPath?: string;
  /** `--target` on a multi-stage build. */
  dockerBuildStage?: string;
}

/**
 * Is this compose file one service that BUILDS FROM ITS OWN REPOSITORY?
 */
export function composeAsRepoApp(compose: string): ComposeRepoApp | null {
  let doc: {
    services?: Record<
      string,
      {
        image?: unknown;
        build?: unknown;
        depends_on?: unknown;
      }
    >;
  } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return null;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return null;
  const keys = Object.keys(services);
  if (keys.length !== 1) return null;

  const key = keys[0]!;
  const svc = services[key];
  if (!svc || typeof svc !== "object") return null;
  // An `image:` next to a `build:` means the build has a name to be pushed
  // under, and Deplo names its own images - but an image ALONE is a stack that
  // pulls, which is a compose app and stays one.
  if (!svc.build) return null;
  if (svc.depends_on) return null;

  const out: ComposeRepoApp = { service: key };
  // `build: .` is the whole block; the long form carries the paths.
  if (typeof svc.build === "object" && !Array.isArray(svc.build)) {
    const b = svc.build as Record<string, unknown>;
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const ctx = str(b.context);
    // "." is the repo root, which is Deplo's default - saying it again would put
    // a value in the build settings that reads as a choice somebody made.
    if (ctx && ctx !== ".") out.dockerContextPath = ctx;
    out.dockerfilePath = str(b.dockerfile);
    out.dockerBuildStage = str(b.target);
  }
  return out;
}

/**
 * The services of a compose file that build from source, by name. A stack Deplo
 * keeps as a stack has no repository behind it, so every one of these is a service
 * that cannot build here.
 */
export function composeBuildServices(compose: string): string[] {
  let doc: { services?: Record<string, { build?: unknown }> } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return [];
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return [];
  return Object.entries(services)
    .filter(([, s]) => s && typeof s === "object" && s.build)
    .map(([k]) => k);
}
