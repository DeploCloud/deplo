import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type YAMLMap,
} from "yaml";

import { composeTruthy } from "./compose-lint/document";

// The proxy's compose file as a document: finding its Traefik service, editing its flags, and mounting Deplo's files.

export const TRAEFIK_CONTAINER = "deplo-traefik";

export const CERT_CONFIG = "deplo-certificates";

export const PANEL_CONFIG = "deplo-panel";

export const DEFAULT_CERT_CONFIG = "deplo-default-cert";

export const RELAY_CONFIG = "deplo-cluster-relay";

export const ANSWER_CONFIG = "deplo-answer";

export const OUR_CONFIGS = [
  CERT_CONFIG,
  PANEL_CONFIG,
  DEFAULT_CERT_CONFIG,
  RELAY_CONFIG,
  ANSWER_CONFIG,
];

export const DEPLO_DYNAMIC_DIR = "/deplo-dynamic";

export const FILE_DIRECTORY_FLAG = "--providers.file.directory=";

export const FILE_WATCH_FLAG = "--providers.file.watch=true";

export function mountDeploConfig(
  doc: Stack,
  service: YAMLMap,
  name: string,
  file: string,
  purpose: string,
  content: string,
): void {
  const command = listOf(service.get("command", true));
  const existingDir = fileProviderDir(command, purpose);
  if (!existingDir) {
    setList(doc, service, "command", [
      ...command,
      `${FILE_DIRECTORY_FLAG}${DEPLO_DYNAMIC_DIR}`,
      FILE_WATCH_FLAG,
    ]);
  }
  const dir = existingDir ?? DEPLO_DYNAMIC_DIR;

  const readOnly = readOnlyMountOver(service, dir);
  if (readOnly)
    throw new Error(
      `This server's proxy mounts ${readOnly} read-only, so Deplo cannot add ${purpose} to it. Make that mount writable, or point --providers.file.directory at a directory Deplo can add a file to.`,
    );

  addTo(doc, service, "configs", {
    source: name,
    target: `${dir}/${file}`,
    ...(service.has("user") ? {} : { mode: 256 }),
  });
  doc.setIn(["configs", name], doc.createNode({ content }));
}

export function dropFileProvider(
  doc: Stack,
  service: YAMLMap,
  removed: string,
): void {
  const configs = doc.get("configs", true);
  const othersRemain =
    isMap(configs) &&
    configs.items.some((pair) => {
      const key = scalar(pair.key);
      return key !== removed && OUR_CONFIGS.includes(key);
    });
  if (othersRemain) return;

  const command = listOf(service.get("command", true));
  if (!command.includes(`${FILE_DIRECTORY_FLAG}${DEPLO_DYNAMIC_DIR}`)) return;
  setList(
    doc,
    service,
    "command",
    command.filter(
      (c) =>
        c !== `${FILE_DIRECTORY_FLAG}${DEPLO_DYNAMIC_DIR}` &&
        c !== FILE_WATCH_FLAG,
    ),
  );
}

export function fileProviderDir(
  command: string[],
  purpose: string,
): string | null {
  if (command.some((c) => c.startsWith("--providers.file.filename=")))
    throw new Error(
      `This server's proxy loads a single Traefik configuration file, so Deplo cannot add ${purpose} alongside it. Point it at a directory (--providers.file.directory) instead.`,
    );
  const found = command.find((c) => c.startsWith(FILE_DIRECTORY_FLAG));
  return found ? found.slice(FILE_DIRECTORY_FLAG.length) : null;
}

export function readOnlyMountOver(
  service: YAMLMap,
  dir: string,
): string | null {
  const mounts = service.get("volumes", true);
  if (!isSeq(mounts)) return null;
  for (const entry of mounts.items) {
    let target = "";
    let readOnly = false;
    if (isScalar(entry)) {
      const parts = String(entry.value).split(":");
      if (parts.length < 2) continue;
      target = parts[1];
      readOnly = (parts[2] ?? "").split(",").includes("ro");
    } else if (isMap(entry)) {
      target = scalar(entry.get("target", true));
      readOnly = composeTruthy(entry.get("read_only"));
    }
    if (readOnly && target && (dir === target || dir.startsWith(`${target}/`)))
      return target;
  }
  return null;
}

export function dropOurConfig(
  doc: Stack,
  service: YAMLMap,
  name: string,
): void {
  const mounts = service.get("configs", true);
  if (isSeq(mounts)) {
    mounts.items = mounts.items.filter((entry) => configSource(entry) !== name);
    if (mounts.items.length === 0) service.delete("configs");
  }
  const configs = doc.get("configs", true);
  if (isMap(configs)) {
    configs.delete(name);
    if (configs.items.length === 0) doc.delete("configs");
  }
}

export function configSource(entry: unknown): string {
  if (isScalar(entry)) return String(entry.value);
  if (isMap(entry)) return String(entry.get("source") ?? "");
  return "";
}

export type Stack = Document.Parsed;

export function parseCompose(text: string): Stack {
  const doc = parseDocument(text);
  if (doc.errors.length > 0)
    throw new Error(
      `Could not read this server's Traefik configuration: ${doc.errors[0].message}`,
    );
  if (!isMap(doc.contents))
    throw new Error(
      "This server's Traefik configuration is not a compose file",
    );
  return doc;
}

export function traefikServiceNode(doc: Stack): YAMLMap | null {
  const services = doc.get("services", true);
  if (!isMap(services)) return null;

  const byName = new Map<string, YAMLMap>();
  for (const pair of services.items) {
    if (isMap(pair.value)) byName.set(scalar(pair.key), pair.value);
  }
  for (const svc of byName.values()) {
    if (String(svc.get("container_name") ?? "") === TRAEFIK_CONTAINER)
      return svc;
  }
  for (const svc of byName.values()) {
    if (
      String(svc.get("image") ?? "")
        .toLowerCase()
        .includes("traefik")
    )
      return svc;
  }
  return byName.get("traefik") ?? null;
}

export function traefikService(doc: Stack): YAMLMap {
  const service = traefikServiceNode(doc);
  if (!service)
    throw new Error(
      "This server's Traefik configuration has no Traefik service in it",
    );
  return service;
}

export function listOf(node: unknown): string[] {
  if (isSeq(node)) return node.items.map(scalar);
  if (isMap(node))
    return node.items.map((p) => `${scalar(p.key)}=${scalar(p.value)}`);
  if (isScalar(node)) return [String(node.value)];
  return [];
}

export function scalar(node: unknown): string {
  if (isScalar(node)) return String(node.value);
  return node == null ? "" : String(node);
}

export function setList(
  doc: Stack,
  owner: YAMLMap,
  key: string,
  next: string[],
): void {
  const node = owner.get(key, true);
  if (isSeq(node)) {
    const pending = new Map<string, string[]>();
    for (const value of next) {
      const bucket = pending.get(entryName(value));
      if (bucket) bucket.push(value);
      else pending.set(entryName(value), [value]);
    }
    node.items = node.items.filter((item) => {
      const bucket = pending.get(entryName(scalar(item)));
      const replacement = bucket?.shift();
      if (replacement === undefined) return false;
      if (isScalar(item)) item.value = replacement;
      return true;
    });
    for (const bucket of pending.values()) {
      for (const value of bucket) node.add(doc.createNode(value));
    }
    if (node.items.length === 0) owner.delete(key);
    return;
  }
  if (next.length === 0) owner.delete(key);
  else owner.set(key, doc.createNode(next));
}

export function entryName(entry: string): string {
  const eq = entry.indexOf("=");
  return eq === -1 ? entry : entry.slice(0, eq);
}

export function addTo(
  doc: Stack,
  owner: YAMLMap,
  key: string,
  value: unknown,
): void {
  const node = owner.get(key, true);
  if (isSeq(node)) node.add(doc.createNode(value));
  else owner.set(key, doc.createNode([value]));
}

export function certResolver(command: string[]): string {
  for (const flag of command) {
    const m = flag.match(/^--certificatesresolvers\.([^.]+)\./);
    if (m) return m[1];
  }
  return "letsencrypt";
}

export function dump(doc: Stack): string {
  return doc.toString({ lineWidth: 0 });
}
