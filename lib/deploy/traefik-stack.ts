import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parse,
  parseDocument,
  type YAMLMap,
} from "yaml";

import { LINK_PATH, LINK_PORT } from "../infra/agent-link/protocol";
import {
  HOST_GATEWAY_ENTRY,
  RELAY_PATH,
  RELAY_TARGET,
  throughHostGateway,
} from "./cluster-relay";
import {
  CERT_CONFIG,
  PANEL_CONFIG,
  RELAY_CONFIG,
  TRAEFIK_CONTAINER,
  certResolver,
  dropFileProvider,
  dropOurConfig,
  dump,
  listOf,
  mountDeploConfig,
  parseCompose,
  scalar,
  setList,
  traefikService,
  type Stack,
} from "./traefik-compose";

export { TRAEFIK_CONTAINER };

/** Every server's Traefik: install scripts write it, and a stack behind it on the same line is moved up when its server links. */
export const TRAEFIK_IMAGE = "traefik:v3.7.17";

const TRAEFIK_TAG = /^traefik:(v\d+\.\d+)(?:\.(\d+))?$/;

/** The stack on TRAEFIK_IMAGE, or null when it already is or runs a release line someone picked by hand. */
export function withTraefikImage(currentYaml: string): string | null {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  const image = service.get("image", true);
  if (!isScalar(image)) return null;
  const pin = TRAEFIK_IMAGE.match(TRAEFIK_TAG)!;
  const m = String(image.value).match(TRAEFIK_TAG);
  if (!m || m[1] !== pin[1]) return null;
  if (m[2] !== undefined && Number(m[2]) >= Number(pin[2])) return null;
  image.value = TRAEFIK_IMAGE;
  withRedirectFallback(doc, service);
  return dump(doc);
}

export function acmeEmail(currentYaml: string): string | null {
  const resolver = stackCertResolver(currentYaml);
  if (resolver === null) return null;
  const command = listOf(
    traefikService(parseCompose(currentYaml)).get("command", true),
  );
  const flag = `--certificatesresolvers.${resolver}.acme.email=`;
  const found = command.find((c) => c.startsWith(flag))?.slice(flag.length);
  // An older installer wrote `${ACME_EMAIL}` itself; its value lives in an env file the panel never reads.
  return !found || found.startsWith("$") ? "" : found;
}

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

export type CustomCertificate = { certPem: string; keyPem: string };

const CERT_FILE = "deplo-certificates.yml";
const PANEL_FILE = "deplo-panel.yml";
const RELAY_FILE = "deplo-cluster-relay.yml";
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

// ponytail: the KEY sits in the host's compose file in cleartext, so the exposure
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

const PANEL_ROUTER = "deplo-panel";

const PANEL_FALLBACK_ROUTER = "deplo-panel-fallback";

export type PanelRoute = {
  domain: string;
  fallbackDomain: string | null;
  https: boolean;
  certResolver: string | null;
  target: string;
  /** Also routes the cluster relay's path to the relay on the host (ADR-0044). */
  relay?: boolean;
};

const PANEL_PRIORITY = 2;

// Servers link in on the panel's own names only: a bare Path() would take the path from every app (ADR-0040).
const LINK_SERVICE = "deplo-link";
const LINK_PRIORITY = 3;
const linkRouterOf = (router: string) => `${router}-link`;

// The cluster relay rides the same names as the link, one path over (ADR-0044).
const RELAY_SERVICE = "deplo-relay";
const RELAY_PRIORITY = 3;
const relayRouterOf = (router: string) => `${router}-relay`;

const REDIRECT_PRIORITY = 1;

// A stopped app takes its own router down with it, and Traefik answers 404 for an
// address it no longer knows. This one is left under every route to say so instead.
const OFFLINE_ROUTER = "deplo-offline";
const OFFLINE_PATH = "/api/offline";
const OFFLINE_PRIORITY = 1;

export const DEFAULT_PANEL_TARGET = "http://deplo:3000";

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
  const relay = http?.routers?.[relayRouterOf(PANEL_ROUTER)] !== undefined;
  return {
    ...(relay ? { relay: true } : {}),
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
    setHostGateway(doc, service, false);
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
  setHostGateway(
    doc,
    service,
    route.relay === true || throughHostGateway(target),
  );
  return dump(doc);
}

/** The address a server's proxy answers the cluster relay on, or null when it carries no such route. */
export function relayRouteHost(currentYaml: string): string | null {
  let content: unknown;
  try {
    content = parseCompose(currentYaml).getIn([
      "configs",
      RELAY_CONFIG,
      "content",
    ]);
  } catch {
    return null;
  }
  if (typeof content !== "string") return null;
  return content.match(/Host\(`([^`]+)`\)/)?.[1] ?? null;
}

/** The relay beside a leader on another server answers on that server's own address (ADR-0044); null takes it out. */
export function withRelayRoute(
  currentYaml: string,
  host: string | null,
): string {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  dropOurConfig(doc, service, RELAY_CONFIG);
  if (!host) {
    dropFileProvider(doc, service, RELAY_CONFIG);
    setHostGateway(doc, service, false);
    return dump(doc);
  }
  const address = assertRoutableHost(
    host,
    "This server has no address for the cluster relay to answer on",
  );
  const file = new Document({
    http: {
      routers: {
        [RELAY_CONFIG]: {
          rule: `Host(\`${address}\`) && Path(\`${RELAY_PATH}\`)`,
          entryPoints: ["websecure"],
          service: RELAY_CONFIG,
          priority: RELAY_PRIORITY,
          tls: {},
        },
      },
      services: {
        [RELAY_CONFIG]: {
          loadBalancer: { servers: [{ url: RELAY_TARGET }] },
        },
      },
    },
  });
  mountDeploConfig(
    doc,
    service,
    RELAY_CONFIG,
    RELAY_FILE,
    "the cluster relay's route",
    file.toString({ lineWidth: 0 }),
  );
  setHostGateway(doc, service, true);
  return dump(doc);
}

// The proxy reaches a process on the host by this name, so it only gets the name while a relay route needs it.
function setHostGateway(doc: Stack, service: YAMLMap, on: boolean): void {
  const hosts = service.get("extra_hosts", true);
  const rest = (isSeq(hosts) ? hosts.items.map(scalar) : []).filter(
    (h) => h !== HOST_GATEWAY_ENTRY,
  );
  if (on) rest.push(HOST_GATEWAY_ENTRY);
  if (rest.length === 0) service.delete("extra_hosts");
  else service.set("extra_hosts", doc.createNode(rest));
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
  const linkRouter = (host: string) => ({
    ...router(host),
    rule: `Host(\`${host}\`) && Path(\`${LINK_PATH}\`)`,
    service: LINK_SERVICE,
    priority: LINK_PRIORITY,
  });
  const relayRouter = (host: string) => ({
    ...router(host),
    rule: `Host(\`${host}\`) && Path(\`${RELAY_PATH}\`)`,
    service: RELAY_SERVICE,
    priority: RELAY_PRIORITY,
  });
  const write = (doc: Document) => {
    const routers = ["http", "routers"];
    doc.setIn([...routers, PANEL_ROUTER], doc.createNode(router(route.domain)));
    placeAfter(doc, routers, PANEL_ROUTER, {
      [linkRouterOf(PANEL_ROUTER)]: linkRouter(route.domain),
    });
    for (const n of [PANEL_ROUTER, PANEL_FALLBACK_ROUTER])
      doc.deleteIn([...routers, relayRouterOf(n)]);
    if (doc.hasIn(["http", "services"]))
      doc.deleteIn(["http", "services", RELAY_SERVICE]);
    let last = linkRouterOf(PANEL_ROUTER);
    if (route.relay) {
      placeAfter(doc, routers, last, {
        [relayRouterOf(PANEL_ROUTER)]: relayRouter(route.domain),
      });
      last = relayRouterOf(PANEL_ROUTER);
    }
    if (route.fallbackDomain && route.fallbackDomain !== route.domain) {
      placeAfter(doc, routers, last, {
        [PANEL_FALLBACK_ROUTER]: router(route.fallbackDomain),
        [linkRouterOf(PANEL_FALLBACK_ROUTER)]: linkRouter(route.fallbackDomain),
        ...(route.relay
          ? {
              [relayRouterOf(PANEL_FALLBACK_ROUTER)]: relayRouter(
                route.fallbackDomain,
              ),
            }
          : {}),
      });
    } else {
      doc.deleteIn([...routers, PANEL_FALLBACK_ROUTER]);
      doc.deleteIn([...routers, linkRouterOf(PANEL_FALLBACK_ROUTER)]);
    }
    // Only on websecure: :80 already redirects everything there, and a second router
    // at the redirect's own priority would be a coin flip between the two.
    doc.setIn(
      ["http", "routers", OFFLINE_ROUTER],
      doc.createNode({
        rule: "HostRegexp(`^.+$`)",
        entryPoints: ["websecure"],
        service: PANEL_ROUTER,
        priority: OFFLINE_PRIORITY,
        middlewares: [OFFLINE_ROUTER],
        tls: {},
      }),
    );
    doc.setIn(
      ["http", "middlewares", OFFLINE_ROUTER],
      doc.createNode({ replacePath: { path: OFFLINE_PATH } }),
    );
    doc.setIn(
      ["http", "services", PANEL_ROUTER],
      doc.createNode({
        loadBalancer: {
          servers: [{ url: route.target }],
          passHostHeader: true,
        },
      }),
    );
    placeAfter(doc, ["http", "services"], PANEL_ROUTER, {
      [LINK_SERVICE]: {
        loadBalancer: { servers: [{ url: linkTarget(route.target) }] },
      },
      ...(route.relay
        ? {
            [RELAY_SERVICE]: {
              loadBalancer: { servers: [{ url: RELAY_TARGET }] },
            },
          }
        : {}),
    });
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

// Sets each entry, a missing one right after the one before it, so the panel writes the file install.sh does.
function placeAfter(
  doc: Document,
  path: string[],
  after: string,
  entries: Record<string, unknown>,
): void {
  let prev = after;
  for (const [key, value] of Object.entries(entries)) {
    const map = doc.getIn(path, true);
    if (!isMap(map) || map.has(key)) {
      doc.setIn([...path, key], doc.createNode(value));
    } else {
      const at = map.items.findIndex(
        (p) => (isScalar(p.key) ? p.key.value : p.key) === prev,
      );
      map.items.splice(
        at < 0 ? map.items.length : at + 1,
        0,
        doc.createPair(key, value),
      );
    }
    prev = key;
  }
}

// The link listener runs in the panel's own process, so it sits beside wherever the panel is reached.
export function linkTarget(panelTarget: string): string {
  try {
    const url = new URL(panelTarget);
    url.port = String(LINK_PORT);
    return url.origin;
  } catch {
    return `http://deplo:${LINK_PORT}`;
  }
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
