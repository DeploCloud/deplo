import {
  composeTruthy,
  interpolates,
  loadComposeDoc,
  type ComposeDocShape,
} from "./document";

export function volumeSource(v: unknown): string | null {
  if (typeof v === "string") {
    const idx = v.indexOf(":");
    if (idx > 0) return v.slice(0, idx);
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

export function isFilesConventionSource(src: string): boolean {
  return /^\.(?:\/|$)/.test(src) && !isEscapingSource(src);
}

export function isEscapingSource(src: string | null | undefined): boolean {
  return Boolean(src && src.split(/[\\/]/).includes(".."));
}

export function isHostBindSource(src: string | null | undefined): boolean {
  if (!src) return false;
  if (interpolates(src)) return true;
  return (
    (src.startsWith("/") || isEscapingSource(src)) &&
    !isFilesConventionSource(src)
  );
}

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

export interface ComposeFileBinding {
  filePath: string;
  service: string;
  mountPath: string;
  readOnly: boolean;
}

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
      const filePath = src.replace(/^\.\/?/, "").replace(/\/+$/, "");
      if (!filePath) continue;
      const { mountPath, readOnly } = volumeTarget(v);
      if (!mountPath) continue;
      out.push({ filePath, service, mountPath, readOnly });
    }
  }
  return out;
}

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

export function composeOwnVolumeKeys(composeYaml: string): string[] {
  const doc = loadComposeDoc<{ volumes?: Record<string, unknown> }>(
    composeYaml,
  );
  const declared = doc?.volumes;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return [];
  return Object.entries(declared as Record<string, unknown>)
    .filter(([, v]) => {
      if (v == null) return true;
      if (typeof v !== "object") return false;
      const spec = v as { external?: unknown; name?: unknown };
      return !spec.external && typeof spec.name !== "string";
    })
    .map(([k]) => k);
}

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
