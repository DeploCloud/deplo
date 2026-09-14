import yaml from "../../yaml";

import { composeTruthy } from "../../deploy/compose-lint/document";

import type { HostMount, NamedVolume } from "../model";

/** Trailing slashes and a missing leading slash are not a difference. */
export function normalizePath(p: string): string {
  const s = p.trim().replace(/\/+$/, "");
  return s.startsWith("/") ? s : `/${s}`;
}

/** Is `child` strictly inside `parent`? (`/a/b` is under `/a`, `/ab` is not.) */
export function isUnderPath(child: string, parent: string): boolean {
  return parent !== "/" ? child.startsWith(`${parent}/`) : child !== "/";
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
  /** A stack binds host directories in its own YAML, where no mount row exists. */
  composeFile?: string | null,
  /** Where that YAML lives on the source machine, so its `./x` binds resolve. */
  stackDir?: string | null,
): HostMount[] {
  const out: HostMount[] = [];
  const seen = new Set<string>();
  for (const m of composeHostMounts(composeFile ?? "", stackDir)) {
    seen.add(m.mountPath);
    out.push(m);
  }
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
 * A `./x` bind source resolved against the directory the stack itself lives in,
 * or null when the source is not one. The SAME rule the renderer applies
 * (`rewriteMountSource`), so the two sides of a copy name the same path.
 */
export function stackRelativePath(
  source: string,
  baseDir: string,
): string | null {
  const s = source.trim();
  if (s.includes("..")) return null; // an escape - the grant gates it, not this
  // `./x` or a bare `.`, never `.env`: a leading dot is not a separator, and
  // inventing `<dir>/env` for it would report a path that is not there.
  const m = /^\.(?:\/(.*))?$/.exec(s);
  if (!m) return null;
  const base = baseDir.replace(/\/+$/, "");
  const rel = (m[1] ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  return rel ? `${base}/${rel}` : base;
}

/**
 * The host directories a compose file binds ITSELF - neither the panel's mount
 * rows nor `app_volumes` saw one, so `- /etc/app:/cfg` arrived byte for byte with
 * an empty directory behind it. A `./x` source counts too: only the FILE came
 * over, never its directory. Resolved against `baseDir`, skipped without one.
 */
export function composeHostMounts(
  compose: string,
  baseDir?: string | null,
): HostMount[] {
  let doc: { services?: Record<string, { volumes?: unknown }> } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return [];
  }
  const out: HostMount[] = [];
  const seen = new Set<string>();
  for (const svc of Object.values(doc?.services ?? {})) {
    if (!Array.isArray(svc?.volumes)) continue;
    for (const raw of svc.volumes) {
      let src: string | undefined;
      let dest: string | undefined;
      if (typeof raw === "string") {
        const parts = raw.split(":");
        src = parts[0]?.trim();
        dest = parts[1]?.trim();
      } else if (raw && typeof raw === "object") {
        const m = raw as { type?: string; source?: string; target?: string };
        if (m.type && m.type !== "bind") continue;
        src = m.source?.trim();
        dest = m.target?.trim();
      }
      if (!src || !dest?.startsWith("/")) continue;
      const relative = baseDir ? stackRelativePath(src, baseDir) : null;
      if (!relative && !src.startsWith("/")) continue;
      const mountPath = normalizePath(dest);
      if (seen.has(mountPath)) continue;
      seen.add(mountPath);
      out.push(
        relative
          ? { hostPath: relative, mountPath, stackRelative: true }
          : { hostPath: normalizePath(src), mountPath },
      );
    }
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
 * The host's own identity, clock and resolver, which half the compose files in the
 * world bind read-only. They belong to the MACHINE, the target already has its own,
 * and copying one would overwrite it.
 */
const HOST_OWNED_FILES = new Set([
  "/etc/localtime",
  "/etc/timezone",
  "/etc/hosts",
  "/etc/hostname",
  "/etc/resolv.conf",
  "/etc/machine-id",
  "/var/lib/dbus/machine-id",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/shadow",
  "/etc/ssl/certs/ca-certificates.crt",
]);

/**
 * Whether a file's content can be carried as a CONFIG FILE. Postgres refuses a NUL
 * in a text column, so a binary file written into `app_mounts` took the whole
 * import down; its bytes belong to the data phase, which copies bind mounts.
 */
export function isTextFileContent(content: string): boolean {
  return !content.includes("\u0000");
}

/** Whether a host path is one a copy has any business reading. */
export function isDataHostPath(hostPath: string): boolean {
  return !NOT_DATA_HOST_PATH.test(hostPath) && !HOST_OWNED_FILES.has(hostPath);
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

  if (input.kind === "compose") {
    // A volume the FILE names is not the project-prefixed one - and the prefix is
    // all a stopped stack has, so an unpinned volume still needs the stack's name.
    const pinned = composeVolumeHostNames(input.composeFile ?? "");
    const project = input.appName.trim();
    for (const v of composeVolumeMounts(input.composeFile ?? ""))
      push(
        pinned.get(v.name) ?? (project ? `${project}_${v.name}` : ""),
        v.mountPath,
      );
  }

  return out;
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
 * The volumes whose real name on the host the compose FILE decides: a pinned
 * `name:` takes that, `external: true` takes the key as written. Neither gets the
 * project prefix, so deriving one from the key names a volume that is not there.
 */
export function composeVolumeHostNames(compose: string): Map<string, string> {
  const out = new Map<string, string>();
  let doc: { volumes?: unknown } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return out;
  }
  const declared = doc?.volumes;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return out;
  for (const [key, body] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const { name, external } = body as { name?: unknown; external?: unknown };
    // `external: {name: x}` is the deprecated spelling of a pinned name.
    const asMap =
      external && typeof external === "object"
        ? (external as { name?: unknown })
        : null;
    const isExternal = Boolean(asMap) || composeTruthy(external);
    const pinned =
      (typeof name === "string" && name.trim()) ||
      (typeof asMap?.name === "string" && asMap.name.trim()) ||
      (isExternal ? key : "");
    if (pinned) out.set(key, pinned);
  }
  return out;
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
