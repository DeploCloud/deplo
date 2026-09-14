import yaml from "../../yaml";

/**
 * Every container path the services of a compose file already mount, in either
 * shape. The renderer skips a Storage volume whose path the authored file
 * declares (`injectAppVolumes`), so the mapper has to know the same paths - or it
 * writes a row the deploy ignores and the data copy fills.
 */
export function composeMountPaths(
  compose: string | null | undefined,
): string[] {
  let doc: { services?: Record<string, { volumes?: unknown }> } | null;
  try {
    doc = yaml.load(compose ?? "") as typeof doc;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const svc of Object.values(doc?.services ?? {})) {
    const mounts = svc?.volumes;
    if (!Array.isArray(mounts)) continue;
    for (const raw of mounts) {
      let dest: string | undefined;
      if (typeof raw === "string") {
        // Same rule as `containerPathOf`: one part is an ANONYMOUS volume, and
        // the path it names is mounted all the same.
        const parts = raw.split(":");
        dest = (parts.length > 1 ? parts[1] : parts[0])?.trim();
      } else if (raw && typeof raw === "object")
        dest = (raw as { target?: string }).target?.trim();
      if (dest) out.push(dest.replace(/\/+$/, ""));
    }
  }
  return out;
}

/** The service names a compose file declares, in the order it declares them. */
export function composeServices(compose: string | null | undefined): string[] {
  try {
    const doc = yaml.load(compose ?? "") as { services?: unknown } | null;
    const services = doc?.services;
    if (!services || typeof services !== "object" || Array.isArray(services))
      return [];
    return Object.keys(services as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * The ONE service a stack's traffic obviously belongs to: the only one that
 * publishes or exposes a port, or the only service there is. `null` the moment it
 * would be a guess - two candidates is a question for a person, not a default.
 */
export function composeServiceExposingPort(
  compose: string | null | undefined,
): string | null {
  let doc: {
    services?: Record<string, { ports?: unknown; expose?: unknown }>;
  } | null;
  try {
    doc = yaml.load(compose ?? "") as typeof doc;
  } catch {
    return null;
  }
  const services = Object.entries(doc?.services ?? {});
  if (services.length === 0) return null;
  if (services.length === 1) return services[0][0];
  const exposing = services.filter(
    ([, svc]) =>
      (Array.isArray(svc?.ports) && svc.ports.length > 0) ||
      (Array.isArray(svc?.expose) && svc.expose.length > 0),
  );
  return exposing.length === 1 ? exposing[0][0] : null;
}

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
