// https://deplo.build/docs/guides/networking/domains-and-https

import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parse,
  parseDocument,
  type YAMLMap,
} from "yaml";

import { composeTruthy } from "./compose-lint/document";

// The host's stack file is EDITED in place: re-rendering it from a template silently drops
// the operator's own config, and they find out when their certificates stop renewing.
// The container the installer creates. A Traefik under any other name is not ours.
export const TRAEFIK_CONTAINER = "deplo-traefik";

// The address this host's certificates are issued under, read off its own flags.
export function acmeEmail(currentYaml: string): string | null {
  const resolver = stackCertResolver(currentYaml);
  if (resolver === null) return null;
  const command = listOf(
    traefikService(parseCompose(currentYaml)).get("command", true),
  );
  const flag = `--certificatesresolvers.${resolver}.acme.email=`;
  const found = command.find((c) => c.startsWith(flag));
  return found ? found.slice(flag.length) : "";
}

// The name of the ACME resolver this host defines, or null when it defines none.
export function stackCertResolver(currentYaml: string): string | null {
  let command: string[];
  try {
    command = listOf(
      traefikService(parseCompose(currentYaml)).get("command", true),
    );
  } catch {
    return null;
  }
  if (!command.some((c) => c.startsWith("--certificatesresolvers.")))
    return null;
  return certResolver(command);
}

// Point this host's ACME resolver at a different account email. Throws when it has none.
export function withAcmeEmail(currentYaml: string, email: string): string {
  const address = email.trim();
  if (!address)
    throw new Error(
      "Enter the email address certificates should be issued under",
    );

  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  withRedirectFallback(doc, service);
  const command = listOf(service.get("command", true));
  if (!command.some((c) => c.startsWith("--certificatesresolvers.")))
    throw new Error(
      "This server's proxy has no Let's Encrypt resolver configured, so there is no certificate account to change.",
    );

  const resolver = certResolver(command);
  const flag = `--certificatesresolvers.${resolver}.acme.email=`;
  const next = command.filter((c) => !c.startsWith(flag));
  next.push(`${flag}${address}`);
  setList(doc, service, "command", next);
  return dump(doc);
}

// One certificate the operator brought themselves: the PEM chain and its key.
export type CustomCertificate = { certPem: string; keyPem: string };

const CERT_CONFIG = "deplo-certificates";
const CERT_FILE = "deplo-certificates.yml";
const PANEL_CONFIG = "deplo-panel";
const PANEL_FILE = "deplo-panel.yml";
// install.sh's fallback certificate. Nothing here writes it - it is listed so removing the
// panel's route or the last custom certificate does not strip the file provider out from under it.
const DEFAULT_CERT_CONFIG = "deplo-default-cert";
const OUR_CONFIGS = [CERT_CONFIG, PANEL_CONFIG, DEFAULT_CERT_CONFIG];
const DEPLO_DYNAMIC_DIR = "/deplo-dynamic";
const FILE_DIRECTORY_FLAG = "--providers.file.directory=";
const FILE_WATCH_FLAG = "--providers.file.watch=true";

// The certificates Deplo installed on this host, read back out of its own stack file.
export function traefikCertificates(currentYaml: string): CustomCertificate[] {
  let text: unknown;
  try {
    text = parseCompose(currentYaml).getIn(["configs", CERT_CONFIG, "content"]);
  } catch {
    return [];
  }
  if (typeof text !== "string") return [];
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return [];
  }
  const list = (parsed as { tls?: { certificates?: unknown } } | null)?.tls
    ?.certificates;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      const e = (entry ?? {}) as { certFile?: unknown; keyFile?: unknown };
      return {
        certPem: typeof e.certFile === "string" ? e.certFile : "",
        keyPem: typeof e.keyFile === "string" ? e.keyFile : "",
      };
    })
    .filter((c) => c.certPem && c.keyPem);
}

// Custom certificates ride in the stack file as a compose `configs` entry: the agent writes no arbitrary path (ADR-0006).
// ponytail: the KEY sits in the host's compose file in cleartext, so the exposure
// is "whoever can read it", i.e. root. Closing it needs an agent RPC that writes a
// secret file, at which point the stack would carry a path instead of a PEM.
export function withTraefikCertificates(
  currentYaml: string,
  certificates: CustomCertificate[],
): string {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  withRedirectFallback(doc, service);

  const currentContent = doc.getIn(["configs", CERT_CONFIG, "content"]);

  dropOurConfig(doc, service, CERT_CONFIG);

  if (certificates.length === 0) {
    dropFileProvider(doc, service, CERT_CONFIG);
    return dump(doc);
  }

  mountDeploConfig(
    doc,
    service,
    CERT_CONFIG,
    CERT_FILE,
    "a certificate file",
    certificateFile(currentContent, certificates),
  );
  return dump(doc);
}

function certificateFile(
  current: unknown,
  certificates: CustomCertificate[],
): string {
  const entries = certificates.map((c) => ({
    certFile: c.certPem,
    keyFile: c.keyPem,
  }));
  const write = (doc: Document) => {
    doc.setIn(["tls", "certificates"], doc.createNode(entries));
    return doc.toString({ lineWidth: 0 });
  };
  if (typeof current === "string") {
    const parsed = parseDocument(current);
    if (parsed.errors.length === 0 && isMap(parsed.contents)) {
      try {
        return write(parsed);
      } catch {}
    }
  }
  return write(new Document({}));
}

function mountDeploConfig(
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
    // 0400, owned by root, which is who the official image runs Traefik as.
    ...(service.has("user") ? {} : { mode: 256 }),
  });
  doc.setIn(["configs", name], doc.createNode({ content }));
}

function dropFileProvider(doc: Stack, service: YAMLMap, removed: string): void {
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

function fileProviderDir(command: string[], purpose: string): string | null {
  if (command.some((c) => c.startsWith("--providers.file.filename=")))
    throw new Error(
      `This server's proxy loads a single Traefik configuration file, so Deplo cannot add ${purpose} alongside it. Point it at a directory (--providers.file.directory) instead.`,
    );
  const found = command.find((c) => c.startsWith(FILE_DIRECTORY_FLAG));
  return found ? found.slice(FILE_DIRECTORY_FLAG.length) : null;
}

function readOnlyMountOver(service: YAMLMap, dir: string): string | null {
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

function dropOurConfig(doc: Stack, service: YAMLMap, name: string): void {
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

function configSource(entry: unknown): string {
  if (isScalar(entry)) return String(entry.value);
  if (isMap(entry)) return String(entry.get("source") ?? "");
  return "";
}

const PANEL_ROUTER = "deplo-panel";

const PANEL_FALLBACK_ROUTER = "deplo-panel-fallback";

// How this host publishes the Deplo panel.
export type PanelRoute = {
  domain: string;
  fallbackDomain: string | null;
  https: boolean;
  certResolver: string | null;
  target: string;
};

// A whole-host router must stay a FALLBACK so an app's own route on the same host outranks
// it, while still beating the entrypoint redirect pinned at 1.
const PANEL_PRIORITY = 2;

const REDIRECT_PRIORITY = 1;

// Where the panel lives on a host `install.sh` set up: the control plane's own compose service name.
export const DEFAULT_PANEL_TARGET = "http://deplo:3000";

// The panel route this host serves, or null when Deplo does not own one.
export function panelRoute(currentYaml: string): PanelRoute | null {
  let content: unknown;
  try {
    content = parseCompose(currentYaml).getIn([
      "configs",
      PANEL_CONFIG,
      "content",
    ]);
  } catch {
    return null;
  }
  if (typeof content !== "string") return null;
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    return null;
  }
  const http = (
    parsed as {
      http?: {
        routers?: Record<string, unknown>;
        services?: Record<string, unknown>;
      };
    } | null
  )?.http;
  const router = http?.routers?.[PANEL_ROUTER] as
    { rule?: unknown; tls?: { certResolver?: unknown } } | undefined;
  const target = (
    http?.services?.[PANEL_ROUTER] as
      { loadBalancer?: { servers?: { url?: unknown }[] } } | undefined
  )?.loadBalancer?.servers?.[0]?.url;
  if (!router || typeof target !== "string" || !target) return null;

  const domain = ruleHost(router.rule);
  if (!domain) return null;
  const resolver = router.tls?.certResolver;
  return {
    domain,
    fallbackDomain: ruleHost(
      (http?.routers?.[PANEL_FALLBACK_ROUTER] as { rule?: unknown } | undefined)
        ?.rule,
    ),
    https: router.tls !== undefined && router.tls !== null,
    certResolver: typeof resolver === "string" && resolver ? resolver : null,
    target,
  };
}

function ruleHost(rule: unknown): string | null {
  if (typeof rule !== "string") return null;
  return rule.match(/^Host\(`([^`]+)`\)$/)?.[1] ?? null;
}

// Publish the Deplo panel on this host's proxy (or, with `null`, stop).
export function withPanelRoute(
  currentYaml: string,
  route: PanelRoute | null,
): string {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  withRedirectFallback(doc, service);

  const currentContent = doc.getIn(["configs", PANEL_CONFIG, "content"]);
  dropOurConfig(doc, service, PANEL_CONFIG);

  if (!route) {
    dropFileProvider(doc, service, PANEL_CONFIG);
    return dump(doc);
  }

  const domain = assertRoutableHost(
    route.domain,
    "A domain is required to publish the Deplo panel",
  );
  const fallbackDomain = route.fallbackDomain
    ? assertRoutableHost(
        route.fallbackDomain,
        "The panel's backup address cannot be empty",
      )
    : null;
  const target = route.target.trim();
  if (!target)
    throw new Error(
      "Deplo does not know where its proxy should send the panel on this server",
    );

  mountDeploConfig(
    doc,
    service,
    PANEL_CONFIG,
    PANEL_FILE,
    "the panel's own route",
    panelFile(currentContent, { ...route, domain, fallbackDomain, target }),
  );
  return dump(doc);
}

function panelFile(current: unknown, route: PanelRoute): string {
  const router = (host: string) => ({
    rule: `Host(\`${host}\`)`,
    entryPoints: [route.https ? "websecure" : "web"],
    service: PANEL_ROUTER,
    priority: PANEL_PRIORITY,
    ...(route.https
      ? { tls: route.certResolver ? { certResolver: route.certResolver } : {} }
      : {}),
  });
  const write = (doc: Document) => {
    doc.setIn(
      ["http", "routers", PANEL_ROUTER],
      doc.createNode(router(route.domain)),
    );
    if (route.fallbackDomain && route.fallbackDomain !== route.domain) {
      doc.setIn(
        ["http", "routers", PANEL_FALLBACK_ROUTER],
        doc.createNode(router(route.fallbackDomain)),
      );
    } else {
      doc.deleteIn(["http", "routers", PANEL_FALLBACK_ROUTER]);
    }
    doc.setIn(
      ["http", "services", PANEL_ROUTER],
      doc.createNode({
        loadBalancer: {
          servers: [{ url: route.target }],
          passHostHeader: true,
        },
      }),
    );
    return doc.toString({ lineWidth: 0 });
  };
  if (typeof current === "string") {
    const parsed = parseDocument(current);
    if (parsed.errors.length === 0 && isMap(parsed.contents)) {
      try {
        return write(parsed);
      } catch {}
    }
  }
  return write(new Document({}));
}

function withRedirectFallback(doc: Stack, service: YAMLMap): void {
  const command = listOf(service.get("command", true));
  const redirection = command.find((c) =>
    /^--entrypoints\.[^.]+\.http\.redirections\.entrypoint\.to=/.test(c),
  );
  if (!redirection) return;
  const prefix = redirection.slice(0, redirection.indexOf(".to="));
  const priorityFlag = `${prefix}.priority=`;
  if (command.some((c) => c.startsWith(priorityFlag))) return;
  setList(doc, service, "command", [
    ...command,
    `${priorityFlag}${REDIRECT_PRIORITY}`,
  ]);
}

function assertRoutableHost(raw: string, missingMessage: string): string {
  const domain = raw.trim().toLowerCase();
  if (!domain) throw new Error(missingMessage);
  if (!/^[a-z0-9.-]+$/.test(domain))
    throw new Error(`"${raw.trim()}" is not a valid hostname`);
  return domain;
}

type Stack = Document.Parsed;

function parseCompose(text: string): Stack {
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

function traefikServiceNode(doc: Stack): YAMLMap | null {
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

function traefikService(doc: Stack): YAMLMap {
  const service = traefikServiceNode(doc);
  if (!service)
    throw new Error(
      "This server's Traefik configuration has no Traefik service in it",
    );
  return service;
}

function listOf(node: unknown): string[] {
  if (isSeq(node)) return node.items.map(scalar);
  if (isMap(node))
    return node.items.map((p) => `${scalar(p.key)}=${scalar(p.value)}`);
  if (isScalar(node)) return [String(node.value)];
  return [];
}

function scalar(node: unknown): string {
  if (isScalar(node)) return String(node.value);
  return node == null ? "" : String(node);
}

// KEEPS the item nodes that survive: rebuilding the list from strings would leave every flag
// in place and drop every line explaining them.
function setList(
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

function entryName(entry: string): string {
  const eq = entry.indexOf("=");
  return eq === -1 ? entry : entry.slice(0, eq);
}

function addTo(doc: Stack, owner: YAMLMap, key: string, value: unknown): void {
  const node = owner.get(key, true);
  if (isSeq(node)) node.add(doc.createNode(value));
  else owner.set(key, doc.createNode([value]));
}

function certResolver(command: string[]): string {
  for (const flag of command) {
    const m = flag.match(/^--certificatesresolvers\.([^.]+)\./);
    if (m) return m[1];
  }
  return "letsencrypt";
}

function dump(doc: Stack): string {
  // lineWidth 0 disables folding - a wrapped basicauth hash or `Host(...)` rule is valid
  // YAML but unreadable in the file an operator may open on the host.
  return doc.toString({ lineWidth: 0 });
}
