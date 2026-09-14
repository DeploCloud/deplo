import {
  composeTruthy,
  interpolates,
  loadComposeDoc,
  type ComposeDocShape,
} from "./document";

// Source side of a volume entry (short `src:dst` form or long `{source}`).
export function volumeSource(v: unknown): string | null {
  if (typeof v === "string") {
    const idx = v.indexOf(":");
    if (idx > 0) return v.slice(0, idx);
    // No ":" is a named/anonymous volume, UNLESS compose fills the whole entry in
    // from a variable: `- ${MOUNT}` is `/:/host` once the env-file is read.
    return interpolates(v) ? v : null;
  }
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (typeof rec.source !== "string") return null;
    if (
      rec.type === "bind" ||
      rec.source.includes("/") ||
      interpolates(rec.source)
    )
      return rec.source;
  }
  return null;
}

// The app-files `./<x>` convention, rewritten to the project's isolated files
// directory at deploy time. Matches `./x`, `./folder/`, bare `.`/`./`; never `../`.
export function isFilesConventionSource(src: string): boolean {
  return /^\.(?:\/|$)/.test(src) && !isEscapingSource(src);
}

// True if a source climbs out of the project sandbox via a `..` path segment. Such
// a source is a host bind (gated behind `canMountHostVolumes`) so a rename can't
// repoint it at another project's data.
export function isEscapingSource(src: string | null | undefined): boolean {
  return Boolean(src && src.split(/[\\/]/).includes(".."));
}

// True if a single compose volume entry bind-mounts a real HOST path. Shared by the
// editor lint and the server-side gate so the two never disagree.
export function isHostBindSource(src: string | null | undefined): boolean {
  if (!src) return false;
  // Compose reads the value AFTER the env-file, so nothing here can tell where an
  // interpolated path points - and `./${X}` is rewritten into the files dir and
  // then climbs out of it. Fail closed: the grant holder can still write one.
  if (interpolates(src)) return true;
  return (
    (src.startsWith("/") || isEscapingSource(src)) &&
    !isFilesConventionSource(src)
  );
}

// Whether ANY service bind-mounts a host path - the server-side gate for
// `canMountHostVolumes`. Tolerant of malformed input: the deploy-time parse is
// the authoritative check.
export function composeHasHostBindMount(composeYaml: string): boolean {
  const doc = loadComposeDoc<ComposeDocShape>(composeYaml);
  const services = doc?.services;
  if (!services || typeof services !== "object") return false;
  for (const svc of Object.values(services)) {
    const vols = svc?.volumes;
    if (!Array.isArray(vols)) continue;
    for (const v of vols) {
      if (isHostBindSource(volumeSource(v))) return true;
    }
  }
  return false;
}

// Where a stack's own compose file binds one of its config files.
export interface ComposeFileBinding {
  // The path inside the app's files dir, as `./<x>` names it.
  filePath: string;
  // The compose service that mounts it.
  service: string;
  // The absolute path it lands on inside that container.
  mountPath: string;
  readOnly: boolean;
}

// Every `./<x>` bind a stack's services declare. The compose is the ONLY thing that
// knows where a config file is mounted, which is what lets Storage show it as a File.
export function composeFileBindings(composeYaml: string): ComposeFileBinding[] {
  const doc = loadComposeDoc<ComposeDocShape>(composeYaml);
  const services = doc?.services;
  if (!services || typeof services !== "object") return [];
  const out: ComposeFileBinding[] = [];
  for (const [service, svc] of Object.entries(services)) {
    const vols = svc?.volumes;
    if (!Array.isArray(vols)) continue;
    for (const v of vols) {
      const src = volumeSource(v);
      if (!src || !isFilesConventionSource(src)) continue;
      // The whole files dir bound as one (`.` / `./`) is not a FILE - there is
      // no single path to show, and Storage has no row shape for it.
      const filePath = src.replace(/^\.\/?/, "").replace(/\/+$/, "");
      if (!filePath) continue;
      const { mountPath, readOnly } = volumeTarget(v);
      if (!mountPath) continue;
      out.push({ filePath, service, mountPath, readOnly });
    }
  }
  return out;
}

// Target side of a volume entry: the container path and whether it is read-only.
export function volumeTarget(v: unknown): {
  mountPath: string;
  readOnly: boolean;
} {
  if (typeof v === "string") {
    const [, target = "", mode = ""] = v.split(":");
    return { mountPath: target.trim(), readOnly: mode.trim() === "ro" };
  }
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    return {
      mountPath: typeof rec.target === "string" ? rec.target.trim() : "",
      readOnly: composeTruthy(rec.read_only),
    };
  }
  return { mountPath: "", readOnly: false };
}

// Every TOP-LEVEL `volumes:` entry pointing at storage Deplo did not create for this
// app: `external:`/a pinned `name:` attaches an existing volume by its deterministic
// host name, `driver_opts: {device: /}` is a bind one level up.
export function foreignVolumeKeys(volumes: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(volumes)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const v = raw as Record<string, unknown>;
    const external = v.external;
    const pinned =
      (typeof external === "object" && external !== null) ||
      composeTruthy(external) ||
      (typeof v.name === "string" && v.name.trim() !== "") ||
      (v.driver_opts != null &&
        typeof v.driver_opts === "object" &&
        Object.keys(v.driver_opts as object).length > 0);
    if (pinned) out.push(key);
  }
  return out;
}

// Top-level `secrets:`/`configs:` keys sourced from a file on the SERVER - the same
// host-file read an `env_file` is, one level up, so the same grant.
export function fileSourcedKeys(entries: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.file === "string" && isHostBindSource(v.file.trim()))
      out.push(key);
  }
  return out;
}

// The volumes DEPLO itself creates for a stack: every top-level entry that is
// neither `external:` nor pinned to its own `name:`. Named for the teardown, which
// a `down -v` cannot reach on a stack that was never deployed.
export function composeOwnVolumeKeys(composeYaml: string): string[] {
  const doc = loadComposeDoc<{ volumes?: Record<string, unknown> }>(
    composeYaml,
  );
  const declared = doc?.volumes;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return [];
  return Object.entries(declared as Record<string, unknown>)
    .filter(([, v]) => {
      if (v == null) return true; // `vol:` with no body - compose creates it
      if (typeof v !== "object") return false;
      const spec = v as { external?: unknown; name?: unknown };
      return !spec.external && typeof spec.name !== "string";
    })
    .map(([k]) => k);
}

// Whether a compose points at storage or host FILES this app does not own. Gated
// server-side behind `canMountHostVolumes`. Tolerant of malformed input.
export function composeMountsForeignStorage(composeYaml: string): boolean {
  const doc = loadComposeDoc<{
    volumes?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
    configs?: Record<string, unknown>;
  }>(composeYaml);
  const asMap = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  return (
    foreignVolumeKeys(asMap(doc?.volumes)).length > 0 ||
    fileSourcedKeys(asMap(doc?.secrets)).length > 0 ||
    fileSourcedKeys(asMap(doc?.configs)).length > 0
  );
}
