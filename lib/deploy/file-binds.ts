// https://deplo.build/docs/guides/data/persistent-storage

import yaml from "../yaml";
import { volumeSource, volumeTarget } from "./compose-lint/volumes";

// Docker answers a missing bind source with an empty DIRECTORY, so file-shaped binds are created empty first.

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

// Well-known config files with no extension; a .ssh-style dir is not here on purpose, a leading dot says nothing.
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

// Whether a path names a FILE by its shape: a known extension or a known name.
export function looksLikeFile(path: string): boolean {
  if (path.endsWith("/")) return false;
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (FILE_NAMES.has(name) || name.startsWith(".env.")) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && FILE_EXTENSIONS.has(name.slice(dot + 1));
}

// A bind is a file when either side of it looks like one (`./nginx:/etc/nginx/nginx.conf`).
export function looksLikeFileMount(source: string, target: string): boolean {
  return looksLikeFile(source) || looksLikeFile(target);
}

function normalizeRel(p: string): string {
  return p.replace(/^(\.\/|\/)+/, "").replace(/\/+$/, "");
}

// The file-shaped binds a rendered stack takes from `filesDir`, relative to it, minus `written`; a knownFiles path is always a file.
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
