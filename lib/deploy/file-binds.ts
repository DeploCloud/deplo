import yaml from "../yaml";
import {
  isFilesConventionSource,
  volumeSource,
  volumeTarget,
} from "./compose-lint/volumes";

const FILE_EXTENSIONS = new Set([
  "yml",
  "yaml",
  "json",
  "toml",
  "conf",
  "cfg",
  "ini",
  "env",
  "txt",
  "xml",
  "properties",
  "sh",
  "py",
  "js",
  "cjs",
  "mjs",
  "ts",
  "sql",
  "pem",
  "crt",
  "cer",
  "key",
  "csr",
  "p12",
  "pfx",
  "db",
  "sqlite",
  "sqlite3",
  "log",
  "html",
  "htm",
  "css",
  "md",
  "cnf",
  "hcl",
  "tmpl",
  "tpl",
  "rules",
  "lua",
  "php",
  "rb",
  "pl",
  "go",
  "jar",
  "zip",
  "tar",
  "gz",
  "tgz",
  "csv",
  "tsv",
  "htpasswd",
  "service",
  "pub",
  "jks",
  "keystore",
  "lock",
  "dat",
  "bin",
  "cert",
  "ovpn",
]);

const FILE_NAMES = new Set([
  "caddyfile",
  "dockerfile",
  "procfile",
  "makefile",
  "license",
  ".env",
  ".htpasswd",
  ".htaccess",
  ".npmrc",
  ".gitconfig",
]);

export function looksLikeFile(path: string): boolean {
  if (path.endsWith("/")) return false;
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (FILE_NAMES.has(name) || name.startsWith(".env.")) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && FILE_EXTENSIONS.has(name.slice(dot + 1));
}

export function looksLikeFileMount(source: string, target: string): boolean {
  return looksLikeFile(source) || looksLikeFile(target);
}

function normalizeRel(p: string): string {
  return p.replace(/^(\.\/|\/)+/, "").replace(/\/+$/, "");
}

export function fileBindsUnderFilesDir(
  stackYaml: string,
  filesDir: string,
  written: Iterable<string> = [],
  knownFiles: Iterable<string> = [],
): string[] {
  let doc: { services?: Record<string, { volumes?: unknown }> } | null;
  try {
    doc = yaml.load(stackYaml) as typeof doc;
  } catch {
    return [];
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return [];
  const root = filesDir.replace(/\/+$/, "") + "/";
  const skip = new Set(Array.from(written, normalizeRel));
  const files = new Set(Array.from(knownFiles, normalizeRel));
  const out = new Set<string>();
  for (const svc of Object.values(services)) {
    if (!Array.isArray(svc?.volumes)) continue;
    for (const v of svc.volumes) {
      const src = volumeSource(v);
      if (!src?.startsWith(root)) continue;
      const rel = normalizeRel(src.slice(root.length));
      if (!rel || skip.has(rel)) continue;
      if (files.has(rel) || looksLikeFileMount(src, volumeTarget(v).mountPath))
        out.add(rel);
    }
  }
  return [...out];
}

// Every source the stack mounts from the app's files, relative to them: the agent refuses one that links outside.
export function filesBindSources(
  stackYaml: string,
  filesDir: string,
): string[] {
  let doc: {
    services?: Record<string, { volumes?: unknown }>;
    secrets?: Record<string, { file?: unknown }>;
    configs?: Record<string, { file?: unknown }>;
  } | null;
  try {
    doc = yaml.load(stackYaml) as typeof doc;
  } catch {
    return [];
  }
  const root = filesDir.replace(/\/+$/, "");
  const out = new Set<string>();
  const add = (src: unknown) => {
    if (typeof src !== "string") return;
    const s = src.trim();
    const rel =
      s === root || s.startsWith(`${root}/`)
        ? s.slice(root.length)
        : isFilesConventionSource(s)
          ? s.slice(1)
          : null;
    const clean = normalizeRel(rel ?? "");
    if (clean && !clean.split("/").includes("..")) out.add(clean);
  };
  for (const svc of Object.values(doc?.services ?? {}))
    if (Array.isArray(svc?.volumes))
      for (const v of svc.volumes) add(volumeSource(v));
  for (const block of [doc?.secrets, doc?.configs])
    for (const entry of Object.values(block ?? {})) add(entry?.file);
  return [...out];
}
