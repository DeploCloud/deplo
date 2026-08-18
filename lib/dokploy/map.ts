/**
 * Dokploy row → deplo input. PURE: no I/O, no DB, no auth, no `server-only`.
 *
 * Everything that is easy to get subtly wrong lives here — the env-file grammar,
 * the build-pack table, the docker memory/CPU suffixes, which domains are worth
 * carrying, the compose network rewrite — precisely so it unit-tests against
 * recorded rows without a Dokploy instance or a database.
 *
 * The convention for anything that cannot be represented: return the value that
 * IS representable and add a line to `notes`. A note becomes a `manual` row in
 * the import report ("imported, but there is one thing to do by hand"), which is
 * the whole difference between a migration you can trust and one that quietly
 * drops half a config. Nothing here throws for missing data.
 */

import yaml from "js-yaml";

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
 * Dokploy keeps env as one `.env`-shaped text column; deplo keeps rows. Same
 * grammar as `importEnv` (blank lines and `#` comments dropped, one layer of
 * matching quotes stripped, invalid keys skipped) plus a tolerated `export `
 * prefix, which people paste in from a shell.
 *
 * Comment lines are lost: deplo has no comment concept on an env row. That was
 * already true of the manual migration and is not worth a note per app.
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
    if (seen.has(key)) out[out.findIndex((e) => e.key === key)] = { key, value };
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
/* Compose: drop Dokploy's shared network                              */
/* ------------------------------------------------------------------ */

const DOKPLOY_NETWORK = "dokploy-network";

/**
 * Every top-level network KEY in this compose that resolves to Dokploy's shared
 * network — which is not only the key `dokploy-network`.
 *
 * Same trap `sharedNetworkKeys` (lib/deploy/compose-lint.ts) documents for
 * deplo's own network: compose lets a network be referenced under any key while
 * pointing elsewhere with `name:`, so `{ web: { external: true, name:
 * dokploy-network } }` is the same network under an alias. A rule that matches
 * the key alone is one rename away from being decorative.
 */
function dokployNetworkKeys(doc: { networks?: unknown }): Set<string> {
  const keys = new Set<string>();
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return keys;
  for (const [key, raw] of Object.entries(declared as Record<string, unknown>)) {
    if (key === DOKPLOY_NETWORK) keys.add(key);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    const ext = n.external;
    const named =
      (typeof n.name === "string" && n.name.trim() === DOKPLOY_NETWORK) ||
      (ext != null &&
        typeof ext === "object" &&
        !Array.isArray(ext) &&
        (ext as Record<string, unknown>).name === DOKPLOY_NETWORK);
    if (named) keys.add(key);
  }
  return keys;
}

/**
 * Turn a Dokploy compose file into a Deplo one. Two rewrites, both mechanical,
 * both necessary, and nothing else is touched — Traefik labels a user wrote by
 * hand included. They are configuration someone chose, and this is an import, not
 * a rewrite.
 *
 * **1. Drop `dokploy-network`.** It does not exist here, and
 * `composeJoinsForeignNetwork` (correctly) treats an external network we do not
 * own as a way out of the sandbox — so importing verbatim would demand the
 * `canMountHostVolumes` grant for every stack, over a network with no purpose
 * here: `buildComposeStack` attaches the services to Deplo's own.
 *
 * **2. Rewrite `../files/x` to `./x`.** Both platforms materialise a service's
 * config files next to the stack and bind them in; they just spell the path
 * differently. Dokploy writes `<stack>/files/<path>` and binds `../files/<path>`;
 * Deplo writes its own isolated files dir and binds `./<path>` (`rewriteMountSource`
 * in compose-stack.ts). Left alone, a `../` source is not merely wrong — Deplo
 * reads it as climbing OUT of the sandbox, so the stack would demand the
 * host-volumes grant and then bind a path that holds nothing. Measured on a real
 * instance, this is the single most common thing in a Dokploy compose file.
 *
 * A source that climbs anywhere ELSE with `..` is left exactly as it is: that one
 * really is a host bind, and Deplo should go on asking for the grant.
 *
 * The YAML is only re-serialized when there IS something to change (a round trip
 * through js-yaml reflows the file and drops comments), so a stack that needed
 * neither rewrite comes across byte-identical.
 */
export function adaptComposeForDeplo(source: string): {
  compose: string;
  changes: string[];
} {
  let doc: Record<string, unknown> | null;
  try {
    doc = yaml.load(source) as Record<string, unknown> | null;
  } catch {
    return { compose: source, changes: [] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return { compose: source, changes: [] };

  const changes: string[] = [];
  const keys = dokployNetworkKeys(doc);

  if (keys.size > 0) {
    const networks = doc.networks as Record<string, unknown> | undefined;
    if (networks) {
      for (const k of keys) delete networks[k];
      if (Object.keys(networks).length === 0) delete doc.networks;
    }
    changes.push(
      "Dokploy's shared network was removed - Deplo attaches the services to its own.",
    );
  }

  const services = doc.services;
  if (services && typeof services === "object" && !Array.isArray(services)) {
    for (const svc of Object.values(services as Record<string, unknown>)) {
      if (!svc || typeof svc !== "object" || Array.isArray(svc)) continue;
      const s = svc as Record<string, unknown>;

      // The network, off both shapes of a service's `networks:`.
      if (keys.size > 0) {
        const n = s.networks;
        if (Array.isArray(n)) {
          const kept = n.filter((entry) => !keys.has(String(entry)));
          if (kept.length === 0) delete s.networks;
          else s.networks = kept;
        } else if (n && typeof n === "object") {
          const map = n as Record<string, unknown>;
          for (const k of keys) delete map[k];
          if (Object.keys(map).length === 0) delete s.networks;
        }
      }

      // The file-mount paths, off both shapes of a volume entry.
      const vols = s.volumes;
      if (!Array.isArray(vols)) continue;
      s.volumes = vols.map((v) => {
        if (typeof v === "string") {
          const idx = v.indexOf(":");
          if (idx <= 0) return v;
          const rewritten = deploFilesPath(v.slice(0, idx));
          if (rewritten == null) return v;
          changes.push(`${v.slice(0, idx)} now points at Deplo's files directory.`);
          return `${rewritten}${v.slice(idx)}`;
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const m = v as Record<string, unknown>;
          if (typeof m.source !== "string") return v;
          const rewritten = deploFilesPath(m.source);
          if (rewritten == null) return v;
          changes.push(`${m.source} now points at Deplo's files directory.`);
          return { ...m, source: rewritten };
        }
        return v;
      });
    }
  }

  if (changes.length === 0) return { compose: source, changes: [] };
  return {
    compose: yaml.dump(doc, { lineWidth: -1, noRefs: true }),
    changes,
  };
}

/**
 * Dokploy's `../files/x` as Deplo spells it, or null when the source is not one
 * of those (a named volume, a real host path, an escape to somewhere else).
 */
function deploFilesPath(source: string): string | null {
  const s = source.trim();
  const m = /^\.\.\/files(?:\/(.*))?$/.exec(s);
  if (!m) return null;
  const rest = (m[1] ?? "").replace(/^\/+/, "");
  return rest ? `./${rest}` : ".";
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
  // silent — a Heroku buildpack with a custom `bin/compile` will not survive it.
  heroku_buildpacks: "nixpacks",
  paketo_buildpacks: "nixpacks",
};

/**
 * Dokploy's per-service build fields → deplo's `BuildConfig`.
 *
 * `buildArgs` deliberately does NOT land here: deplo passes env vars to the
 * build (agent ≥ 1.9.0), so the caller merges them into the env set instead —
 * one mechanism rather than two.
 */
export function mapBuildSettings(
  app: DokployApplication,
): Mapped<Partial<BuildConfig>> {
  const notes: string[] = [];
  const buildMethod = BUILD_METHOD[app.buildType] ?? "nixpacks";
  if (app.buildType === "heroku_buildpacks" || app.buildType === "paketo_buildpacks")
    notes.push(
      `Built with ${app.buildType.replace("_", " ")} on Dokploy. Set to Nixpacks - check the build.`,
    );

  const build: Partial<BuildConfig> = { buildMethod };
  const methodSettings: BuildConfig["methodSettings"] = {};

  // ONLY the settings the chosen builder reads. Dokploy stores a value in every
  // one of these columns whether or not the app uses that builder — measured on a
  // real instance, a Nixpacks app carries `dockerfile: "Dockerfile"` and
  // `railpackVersion: "0.15.4"` — and importing those would pin an unrelated
  // builder to a version this app never asked for, out of what is really just the
  // other platform's column default.
  if (buildMethod === "dockerfile") {
    if (app.dockerfile?.trim()) methodSettings.dockerfilePath = app.dockerfile.trim();
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
  if (Object.keys(methodSettings).length > 0) build.methodSettings = methodSettings;

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
 * ponytail: the column is free text and holds two conventions — cores as a
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
      notes.push(`${label} "${raw.trim()}" is not a value Deplo can read - set it by hand.`);

  // Dokploy's cpuReservation is a swarm scheduling hint with no deplo column.
  if (row.cpuReservation?.trim())
    notes.push(
      `CPU reservation "${row.cpuReservation.trim()}" is a Swarm placement hint. Deplo has no equivalent, so it is not imported.`,
    );

  // A reservation above the limit is what deplo's own validator refuses; drop it
  // rather than lose the limit too.
  const reservation =
    memoryReservationMb != null && memoryMb != null && memoryReservationMb > memoryMb
      ? null
      : memoryReservationMb;
  if (reservation !== memoryReservationMb)
    notes.push("Memory reservation is above the limit on Dokploy - not imported.");

  if (memoryMb == null && reservation == null && cpuMilli == null)
    return { value: null, notes };
  return {
    value: { memoryMb, memoryReservationMb: reservation, cpuMilli },
    notes,
  };
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
 *
 * Every git flavour lands as deplo's plain `git` source with an https clone URL:
 * the tokens and GitHub App installations that authenticated the clone on Dokploy
 * are excluded from its API on purpose, so there is no credential to carry. A
 * public repo clones anonymously and works immediately; a private one needs a git
 * connection attached afterwards, which is what the note says. The caller may
 * still fill `connectionId` when the team already has a connection for the same
 * host.
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
      notes.push(`Image reference "${truncate(image, 80)}" is not one Deplo accepts - set it by hand.`);
      return { value: { kind: "none" }, notes };
    }
    if (app.registryId || app.registry)
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
    notes.push("Could not work out the repository from Dokploy - set the source by hand.");
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
  const host = (raw: string | null | undefined, fallback: string): string => {
    const v = raw?.trim();
    if (!v) return fallback;
    try {
      return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).origin;
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
      const owner = a.gitlabPathNamespace?.trim() || a.gitlabOwner?.trim();
      if (!owner || !a.gitlabRepository) return null;
      const origin = host(a.gitlab?.gitlabUrl, "https://gitlab.com");
      return {
        provider: "gitlab",
        url: `${origin}/${owner}/${a.gitlabRepository}.git`,
        repo: `${owner}/${a.gitlabRepository}`,
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
      const slug = a.bitbucketRepositorySlug?.trim() || a.bitbucketRepository?.trim();
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
 * Carrying one over would point at the old VPS and ask Let's Encrypt for a
 * certificate on a name we do not control. deplo mints its own instead.
 */
const THROWAWAY_HOST_RE =
  /(^|\.)(traefik\.me|sslip\.io|nip\.io|localhost)$/i;

export function isThrowawayHost(host: string): boolean {
  return THROWAWAY_HOST_RE.test(host.trim().toLowerCase());
}

export interface MappedDomain {
  host: string;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
  certProvider: CertProvider;
  entrypoint: DomainEntrypoint;
  service: string | null;
}

/**
 * The domains worth importing, in Dokploy's own order (the first survivor becomes
 * deplo's primary).
 *
 * Dropped without a note: preview domains (deplo generates its own per PR),
 * disabled rows, and the throwaway hosts above. Everything else comes across with
 * its path, port, service and certificate choice.
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
    if (isThrowawayHost(host)) continue;

    let certProvider: CertProvider = "none";
    if (d.certificateType === "letsencrypt") certProvider = "letsencrypt";
    else if (d.certificateType === "custom")
      notes.push(
        `${host} uses a custom certificate resolver on Dokploy. Imported without a certificate - pick one in Domains.`,
      );

    const path = (d.path ?? "/").trim();
    const pathPrefix = path === "/" ? "" : path;
    const port = d.port ?? opts.fallbackPort ?? null;
    if (opts.isCompose && port == null)
      notes.push(`${host} has no container port set - Deplo needs one for a compose stack.`);

    out.push({
      host,
      port,
      pathPrefix,
      stripPrefix: pathPrefix ? d.stripPath === true : false,
      certProvider,
      entrypoint: d.https === false && certProvider === "none" ? "web" : "websecure",
      service: opts.isCompose ? (d.serviceName?.trim() || null) : null,
    });
  }
  return { value: out, notes };
}

/* ------------------------------------------------------------------ */
/* Mounts                                                             */
/* ------------------------------------------------------------------ */

export interface MappedMounts {
  /** Config files written into the app's files dir at deploy time. */
  files: { filePath: string; content: string }[];
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
 * Dokploy's three mount kinds → deplo's two writers.
 *
 * `file` mounts (inline content) ride along in `createApp`; `volume` and `bind`
 * go through `setAppVolumes` afterwards. A bind mount needs the
 * `canMountHostVolumes` grant, so it may be refused there — the report says which
 * path was refused rather than dropping it silently.
 */
export function mapMounts(
  mounts: DokployMount[] | null | undefined,
): Mapped<MappedMounts> {
  const notes: string[] = [];
  const files: { filePath: string; content: string }[] = [];
  const volumes: Omit<VolumeMount, "id">[] = [];
  const used = new Set<string>();

  for (const m of mounts ?? []) {
    const mountPath = m.mountPath?.trim();
    if (m.type === "file") {
      // Dokploy writes the file next to the stack and bind-mounts it; deplo owns
      // the whole files dir, so only the file's own name travels.
      const name = (m.filePath ?? "").trim().replace(/^\.?\//, "");
      if (!name) {
        notes.push("A file mount has no path on Dokploy - not imported.");
        continue;
      }
      files.push({ filePath: name, content: m.content ?? "" });
      continue;
    }
    if (!mountPath) {
      notes.push("A mount has no container path on Dokploy - not imported.");
      continue;
    }
    if (m.type === "volume") {
      const base = volumeLabel(m.volumeName ?? "", volumeLabel(mountPath, "data"));
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
      used.add(name);
      volumes.push({ type: "named", name, mountPath, readOnly: false });
      continue;
    }
    // bind
    const hostPath = m.hostPath?.trim();
    if (!hostPath) {
      notes.push(`Bind mount at ${mountPath} has no host path on Dokploy - not imported.`);
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

const DB_ENGINE: Partial<Record<DokployDbKind, DatabaseType>> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongodb",
  redis: "redis",
};

/**
 * The deplo engine for one of Dokploy's database tables, or null when there is
 * none (libsql).
 *
 * Exported so the decision is made BEFORE the detail call: asking Dokploy for a
 * libsql row we can do nothing with produces a 404 and a report line about HTTP,
 * when the honest answer - "Deplo has no libsql engine" - was knowable without
 * leaving the building.
 */
export function deploEngineFor(kind: DokployDbKind): DatabaseType | null {
  return DB_ENGINE[kind] ?? null;
}

export interface MappedDatabase {
  type: DatabaseType;
  name: string;
  /** Image tag, or null to let deplo pick its default for the engine. */
  version: string | null;
  username: string | null;
  dbName: string | null;
  password: string | null;
  exposedPort: number | null;
  /** Set when Dokploy ran an image that is not the canonical `<engine>:<tag>`. */
  customImage: string | null;
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
 *
 * The password is carried over ON PURPOSE, even though deplo would happily mint
 * one: every imported app's `DATABASE_URL` still spells out the old password, so
 * regenerating it here would break the apps in a way nobody would connect back
 * to this import. deplo's own policy may still refuse it, and then the caller
 * reports loudly.
 *
 * `libsql` returns null - deplo has no such engine.
 */
export function mapDatabase(
  kind: DokployDbKind,
  row: DokployDatabase,
): Mapped<MappedDatabase | null> {
  const notes: string[] = [];
  const type = DB_ENGINE[kind];
  if (!type) {
    notes.push(`${row.name}: Deplo has no ${kind} engine - not imported.`);
    return { value: null, notes };
  }

  const version = imageTag(row.dockerImage);
  const repo = imageRepo(row.dockerImage);
  const canonical =
    !repo ||
    repo === kind ||
    repo === type ||
    repo === `library/${kind}` ||
    (kind === "mongo" && repo === "mongo");
  const customImage = canonical ? null : (row.dockerImage?.trim() ?? null);
  if (customImage)
    notes.push(
      `Runs ${customImage} on Dokploy instead of a plain ${type}. Kept as it is - check that it starts.`,
    );

  if (row.command?.trim())
    notes.push(
      `Custom start command on Dokploy ("${truncate(row.command.trim(), 60)}") - set it under Advanced if you still need it.`,
    );
  if ((row.mounts ?? []).length > 0)
    notes.push(
      "Extra files and volumes are mounted on Dokploy. A Deplo database gets only its data volume, so they do not come across.",
    );

  return {
    value: {
      type,
      // The tree's row has no name for a database (only its id), so a caller that
      // maps one straight from `project.all` would create "" here. The detail row
      // always has it; the fallback keeps this pure function total either way.
      name: row.name?.trim() || "database",
      version,
      username: row.databaseUser?.trim() || null,
      dbName: row.databaseName?.trim() || null,
      password: row.databasePassword?.trim() || null,
      exposedPort: row.externalPort ?? null,
      customImage,
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
 *
 * Bind mounts are dropped: a host path is not a volume, deplo would have imported
 * it as a bind mount pointing at the same place, and copying a host directory is
 * a different operation with a different blast radius.
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
  return out;
}

/**
 * Match every source volume to the deplo volume that should receive it.
 *
 * The container PATH is the identity: `/app/uploads` on one platform is
 * `/app/uploads` on the other, whatever either called the volume.
 *
 * `singleData` is for a database, where each side has exactly one data volume and
 * the paths routinely DISAGREE - postgres 18 defaults its data dir to
 * `/var/lib/postgresql/18/docker` while Deplo mounts `/var/lib/postgresql/data`.
 * One volume on each side has no ambiguity to resolve, so they are paired anyway
 * and the note names both paths, because that mismatch is also the thing most
 * likely to stop the imported database from starting.
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
        "The copy is still the right one (one data volume on each side), but check the database starts - a newer Postgres refuses the older path unless PGDATA is set explicitly.",
    });
  }

  for (const s of source)
    if (!pairs.some((p) => p.sourceVolume === s.name))
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
 * The on-disk name of one of an app's volumes. Two shapes, and the difference is
 * whether Deplo wrote the volume into the stack itself:
 *
 *  - a volume Deplo manages (an `app_volumes` row) is rendered with an explicit
 *    `name:`, which docker-compose uses verbatim: `deplo-<slug>-<alias>`;
 *  - a volume declared in the user's OWN compose has no `name:`, so compose
 *    prefixes it with the project: `deplo-<slug>_<alias>`.
 *
 * The project is always `deplo-<slug>` (the agent runs `docker compose -p
 * deplo-<slug>`), which is also why a database's volume is
 * `deplo-db-<slug>_db-<slug>-data`: its stack's slug IS `db-<slug>`.
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
 *
 * Only top-level `volumes:` entries matter (a named volume); a bind mount or an
 * anonymous mount is not something a data move can pair. The first service that
 * mounts an alias wins the path — two services sharing one volume mount it at the
 * same place in every stack worth migrating, and picking one is better than
 * refusing to move it.
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
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return [];
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
    .map((p) => `${p.publishedPort}->${p.targetPort}${p.protocol ? `/${p.protocol}` : ""}`)
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
  return notes;
}
