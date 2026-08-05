import {
  isMap,
  isScalar,
  isSeq,
  parse,
  parseDocument,
  stringify,
  type Document,
  type YAMLMap,
} from "yaml";

/**
 * The `deplo-traefik` stack file, control-plane side.
 *
 * ADR-0006 puts every Traefik label grammar in `lib/deploy` and nothing in Go, so
 * the agent's TraefikConfig RPC takes an opaque YAML string and applies it. This
 * module is what produces that string.
 *
 * It TRANSFORMS the host's current stack rather than re-rendering one from a
 * template. That matters: the file was written by `install-agent.sh` with values
 * only the host knows — the ACME email the operator passed at install time, the
 * absolute path of the acme volume (`$AGENT_DATA/traefik/acme`), and any flag
 * they have since added (a DNS resolver, an extra entrypoint). Re-rendering from
 * a template would silently drop all of it, and the operator would find out when
 * their certificates stopped renewing.
 *
 * "Transform" is meant literally, down to the comments: the file is parsed as a
 * DOCUMENT and edited in place (see {@link Stack}), because on a host whose proxy
 * the operator maintains by hand, the line explaining a flag is as load-bearing
 * as the flag. A load/dump through plain objects keeps every setting and erases
 * every word explaining it — the same loss this module exists to refuse, one
 * layer down.
 *
 * The dashboard is Traefik's own web UI. Two pieces are needed and only one can
 * come from a label: `--api.dashboard=true` is STATIC config, so enabling it
 * genuinely requires rewriting this file and recreating the container. The
 * router that publishes it is labels, like any other route.
 */

/** The container the installer creates. A Traefik under any other name is not ours. */
export const TRAEFIK_CONTAINER = "deplo-traefik";

/** Router + middleware names for the dashboard route. Also the removal marker. */
const ROUTER = "deplo-traefik-dashboard";
const AUTH_MIDDLEWARE = `${ROUTER}-auth`;

/** The static flag that turns the dashboard on. Not settable via a label. */
const DASHBOARD_FLAG = "--api.dashboard=true";

/**
 * Written beside our router labels when WE are the ones who added
 * {@link DASHBOARD_FLAG}, so unpublishing can take the flag back out without
 * stealing a dashboard the operator had enabled themselves. It is a plain Docker
 * label (not `traefik.*`), so Traefik never looks at it; it exists so the file
 * answers "whose flag is this?" instead of us guessing from what else is there.
 */
const FLAG_MARKER = "deplo.traefik.dashboard-flag=deplo";

export type TraefikDashboard = {
  /** The host the dashboard answers on. */
  domain: string;
  /**
   * htpasswd lines (`user:$apr1$…`) with SINGLE `$`, as {@link htpasswdLine}
   * produces them. The compose escaping is applied here.
   */
  htpasswdUsers: string;
};

/**
 * Turn the dashboard on (or off, with `dashboard: null`) in an existing
 * `deplo-traefik` compose file, returning the new YAML.
 *
 * Throws when the input is not a compose file with a Traefik service — the agent
 * refuses to write a stack Deplo did not install, and this refuses to render one.
 */
export function withTraefikDashboard(
  currentYaml: string,
  dashboard: TraefikDashboard | null,
): string {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);

  const command = listOf(service.get("command", true));
  const labels = listOf(service.get("labels", true));

  // Our own labels always come off first, so enabling twice is idempotent and
  // disabling leaves whatever the operator added untouched. `traefik.enable` is
  // deliberately NOT treated as ours here — see the disable branch.
  const kept = labels.filter((l) => !isOurs(l) && !l.startsWith("traefik.enable="));

  if (!dashboard) {
    // The static flag comes out only when we put it there. The installer writes
    // no `--api.dashboard`, but an operator who turned Traefik's dashboard on
    // themselves (typically with `--api.insecure` on a loopback port) did, and
    // stripping it would take away a page Deplo never published.
    if (labels.includes(FLAG_MARKER)) {
      setList(doc, service, "command", command.filter((c) => c !== DASHBOARD_FLAG));
    }
    // `traefik.enable=true` is ours only when nothing else on this container
    // needs it. The installer's Traefik carries no labels at all, so an orphan
    // enable is our leftover — but an operator who added their own route to this
    // container still needs it, and removing it would silently unpublish them.
    const needsEnable = kept.some((l) => l.startsWith("traefik."));
    setList(doc, service, "labels", needsEnable ? ["traefik.enable=true", ...kept] : kept);
    return dump(doc);
  }

  const domain = dashboard.domain.trim().toLowerCase();
  if (!domain) throw new Error("A domain is required to publish the Traefik dashboard");
  if (!dashboard.htpasswdUsers.trim())
    throw new Error("Credentials are required to publish the Traefik dashboard");

  // Claim the flag only when we are the one adding it — a host that already had
  // it keeps it when the panel is turned off again.
  const ourFlag = !command.includes(DASHBOARD_FLAG) || labels.includes(FLAG_MARKER);
  if (!command.includes(DASHBOARD_FLAG)) command.push(DASHBOARD_FLAG);
  setList(doc, service, "command", command);

  setList(doc, service, "labels", [
    "traefik.enable=true",
    ...(ourFlag ? [FLAG_MARKER] : []),
    `traefik.http.routers.${ROUTER}.rule=Host(\`${domain}\`)`,
    `traefik.http.routers.${ROUTER}.entrypoints=websecure`,
    `traefik.http.routers.${ROUTER}.tls.certresolver=${certResolver(command)}`,
    // api@internal is Traefik's built-in handler for its own dashboard + API.
    `traefik.http.routers.${ROUTER}.service=api@internal`,
    `traefik.http.routers.${ROUTER}.middlewares=${AUTH_MIDDLEWARE}`,
    // `$` is doubled because this lands in a compose file, which reads a single
    // `$` as variable interpolation and would eat the hash — the same escaping
    // routing.ts applies to an app's basic-auth label.
    `traefik.http.middlewares.${AUTH_MIDDLEWARE}.basicauth.users=` +
      dashboard.htpasswdUsers.replace(/\$/g, "$$$$"),
    ...kept,
  ]);
  return dump(doc);
}

/* ------------------------------------------------------------------ */
/* The Let's Encrypt account email                                     */
/* ------------------------------------------------------------------ */

/**
 * The address this host's certificates are issued under, read off its own flags.
 *
 * `null` when the stack defines no ACME resolver at all: a host behind a proxy
 * that terminates TLS elsewhere, or one installed without HTTPS. That is a
 * different answer from "no email set" and the caller must be able to tell them
 * apart, because only one of the two is worth offering to change.
 */
export function acmeEmail(currentYaml: string): string | null {
  let command: string[];
  try {
    command = listOf(traefikService(parseCompose(currentYaml)).get("command", true));
  } catch {
    return null;
  }
  if (!command.some((c) => c.startsWith("--certificatesresolvers."))) return null;
  const resolver = certResolver(command);
  const flag = `--certificatesresolvers.${resolver}.acme.email=`;
  const found = command.find((c) => c.startsWith(flag));
  return found ? found.slice(flag.length) : "";
}

/**
 * Point this host's ACME resolver at a different account email.
 *
 * Only the email flag moves. Everything else in the file (the resolver name the
 * host actually uses, the challenge type, the storage path, the operator's own
 * flags) is left exactly as it was, for the reason this whole module transforms
 * instead of rendering (see the file comment).
 *
 * Throws when the stack has no ACME resolver: adding a bare email flag to a
 * proxy that issues no certificates would write a setting that does nothing and
 * report it as applied.
 */
export function withAcmeEmail(currentYaml: string, email: string): string {
  const address = email.trim();
  if (!address) throw new Error("Enter the email address certificates should be issued under");

  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  const command = listOf(service.get("command", true));
  if (!command.some((c) => c.startsWith("--certificatesresolvers.")))
    throw new Error(
      "This server's proxy has no Let's Encrypt resolver configured, so there is no certificate account to change.",
    );

  const resolver = certResolver(command);
  const flag = `--certificatesresolvers.${resolver}.acme.email=`;
  const next = command.filter((c) => !c.startsWith(flag));
  // Appended rather than inserted in place: flag order is irrelevant to Traefik,
  // and appending keeps the diff on the host's file to one line.
  next.push(`${flag}${address}`);
  setList(doc, service, "command", next);
  return dump(doc);
}

/* ------------------------------------------------------------------ */
/* Custom certificates                                                 */
/* ------------------------------------------------------------------ */

/** One certificate the operator brought themselves: the PEM chain and its key. */
export type CustomCertificate = { certPem: string; keyPem: string };

/** Our compose config, the file it becomes, and the directory we serve it from. */
const CERT_CONFIG = "deplo-certificates";
const CERT_FILE = "deplo-certificates.yml";
const DEPLO_DYNAMIC_DIR = "/deplo-dynamic";
const FILE_DIRECTORY_FLAG = "--providers.file.directory=";
const FILE_WATCH_FLAG = "--providers.file.watch=true";

/**
 * The certificates Deplo installed on this host, read back out of its own stack
 * file — the same read-live-not-stored rule the ACME email follows, so a host
 * someone edited by hand reports what it is actually serving.
 */
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
  const list = (parsed as { tls?: { certificates?: unknown } } | null)?.tls?.certificates;
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

/**
 * Install (or, with an empty list, remove) custom certificates on a host.
 *
 * Two pieces are needed and neither can come from a label: Traefik only reads
 * certificates from its FILE provider, and the file has to exist inside the
 * container. Both ride in the stack file itself — a compose `configs` entry with
 * inline `content`, which Docker materialises into the container on `up`. That
 * is deliberate: the agent has no RPC that writes an arbitrary path on the host
 * (ADR-0006 keeps host writes to the ones it exposes), and the stack file is
 * something Deplo is already allowed to rewrite. The PEM goes in verbatim —
 * Traefik's `certFile`/`keyFile` take either a path or the certificate itself.
 *
 * The operator's own file provider is respected when they have one: our file is
 * dropped into THEIR directory rather than a second provider being declared,
 * which Traefik would refuse. A provider pinned to a single `filename` has no
 * room for another file, and that is a refusal, not something to work around
 * by replacing the file they configured.
 */
export function withTraefikCertificates(
  currentYaml: string,
  certificates: CustomCertificate[],
): string {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  const command = listOf(service.get("command", true));

  // Ours always comes off first, so installing twice replaces rather than stacks.
  dropOurConfig(doc, service);

  if (certificates.length === 0) {
    // The flags come out only when they are ours. An operator who pointed the
    // file provider somewhere of their own keeps it: removing our certificates
    // must not unload their middlewares along with them.
    if (ourDynamicDir(command)) {
      setList(
        doc,
        service,
        "command",
        command.filter(
          (c) => c !== `${FILE_DIRECTORY_FLAG}${DEPLO_DYNAMIC_DIR}` && c !== FILE_WATCH_FLAG,
        ),
      );
    }
    return dump(doc);
  }

  const existingDir = fileProviderDir(command);
  if (!existingDir) {
    setList(doc, service, "command", [
      ...command,
      `${FILE_DIRECTORY_FLAG}${DEPLO_DYNAMIC_DIR}`,
      FILE_WATCH_FLAG,
    ]);
  }
  const dir = existingDir ?? DEPLO_DYNAMIC_DIR;

  addTo(doc, service, "configs", { source: CERT_CONFIG, target: `${dir}/${CERT_FILE}` });
  doc.setIn(
    ["configs", CERT_CONFIG],
    doc.createNode({
      content: stringify(
        {
          tls: {
            certificates: certificates.map((c) => ({
              certFile: c.certPem,
              keyFile: c.keyPem,
            })),
          },
        },
        { lineWidth: 0 },
      ),
    }),
  );
  return dump(doc);
}

/** The file provider's directory when the stack already declares one. Throws for
 *  a provider pinned to one filename — see withTraefikCertificates. */
function fileProviderDir(command: string[]): string | null {
  if (command.some((c) => c.startsWith("--providers.file.filename=")))
    throw new Error(
      "This server's proxy loads a single Traefik configuration file, so Deplo cannot add a certificate file alongside it. Point it at a directory (--providers.file.directory) to use custom certificates here.",
    );
  const found = command.find((c) => c.startsWith(FILE_DIRECTORY_FLAG));
  return found ? found.slice(FILE_DIRECTORY_FLAG.length) : null;
}

/** Whether the file provider on this host is the one WE added. */
function ourDynamicDir(command: string[]): boolean {
  return command.includes(`${FILE_DIRECTORY_FLAG}${DEPLO_DYNAMIC_DIR}`);
}

/**
 * Take our certificate config off both the service and the top level, in either
 * compose syntax, leaving every other entry — and the comments attached to them —
 * where they are.
 */
function dropOurConfig(doc: Stack, service: YAMLMap): void {
  const mounts = service.get("configs", true);
  if (isSeq(mounts)) {
    mounts.items = mounts.items.filter((entry) => configSource(entry) !== CERT_CONFIG);
    if (mounts.items.length === 0) service.delete("configs");
  }
  const configs = doc.get("configs", true);
  if (isMap(configs)) {
    configs.delete(CERT_CONFIG);
    if (configs.items.length === 0) doc.delete("configs");
  }
}

/** The config a service `configs` entry names, in either syntax (`- name` or
 *  `- source: name`). */
function configSource(entry: unknown): string {
  if (isScalar(entry)) return String(entry.value);
  if (isMap(entry)) return String(entry.get("source") ?? "");
  return "";
}

/** Whether this stack currently publishes the dashboard, and on which host. */
export function traefikDashboardDomain(currentYaml: string): string | null {
  let service: YAMLMap | null;
  try {
    service = traefikServiceNode(parseCompose(currentYaml));
  } catch {
    return null;
  }
  if (!service) return null;
  if (!listOf(service.get("command", true)).includes(DASHBOARD_FLAG)) return null;
  for (const label of listOf(service.get("labels", true))) {
    const m = label.match(
      new RegExp(`^traefik\\.http\\.routers\\.${ROUTER}\\.rule=Host\\(\`([^\`]+)\`\\)$`),
    );
    if (m) return m[1];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

/**
 * The host's stack, parsed as a YAML document and edited in place.
 *
 * A document rather than plain objects because a plain object cannot hold a
 * comment: `parseDocument` → mutate → `toString` keeps the file's comments,
 * quoting and layout and touches only the keys we actually change. See the file
 * comment for why that is a requirement rather than a nicety.
 */
type Stack = Document.Parsed;

function parseCompose(text: string): Stack {
  const doc = parseDocument(text);
  if (doc.errors.length > 0)
    throw new Error(
      `Could not read this server's Traefik configuration: ${doc.errors[0].message}`,
    );
  if (!isMap(doc.contents))
    throw new Error("This server's Traefik configuration is not a compose file");
  return doc;
}

/**
 * The service holding Traefik. Matched by container_name first (the installer
 * pins `deplo-traefik`), then by image, then by the conventional `traefik` key —
 * so a hand-renamed service still resolves.
 */
function traefikServiceNode(doc: Stack): YAMLMap | null {
  const services = doc.get("services", true);
  if (!isMap(services)) return null;

  const byName = new Map<string, YAMLMap>();
  for (const pair of services.items) {
    if (isMap(pair.value)) byName.set(scalar(pair.key), pair.value);
  }
  for (const svc of byName.values()) {
    if (String(svc.get("container_name") ?? "") === TRAEFIK_CONTAINER) return svc;
  }
  for (const svc of byName.values()) {
    if (String(svc.get("image") ?? "").toLowerCase().includes("traefik")) return svc;
  }
  return byName.get("traefik") ?? null;
}

function traefikService(doc: Stack): YAMLMap {
  const service = traefikServiceNode(doc);
  if (!service)
    throw new Error("This server's Traefik configuration has no Traefik service in it");
  return service;
}

/**
 * compose accepts `labels`/`command` as either a list or a map (`KEY: value`).
 * Everything here works on the list form, which is also what the installer
 * writes and what every other Deplo renderer emits.
 */
function listOf(node: unknown): string[] {
  if (isSeq(node)) return node.items.map(scalar);
  if (isMap(node)) return node.items.map((p) => `${scalar(p.key)}=${scalar(p.value)}`);
  if (isScalar(node)) return [String(node.value)];
  return [];
}

/** A node's scalar text, for the flag and label lists this module reads. */
function scalar(node: unknown): string {
  if (isScalar(node)) return String(node.value);
  return node == null ? "" : String(node);
}

/**
 * Replace a `command`/`labels` list, KEEPING the item nodes that survive.
 *
 * Keeping nodes is what keeps comments: a comment belongs to the item it sits
 * above, so on a hand-maintained proxy "# Let's Encrypt via HTTP-01 on :80"
 * lives INSIDE the command list. Rebuilding that list from strings would leave
 * every flag in place and drop every line explaining them.
 *
 * An entry whose NAME (everything up to the first `=`) is unchanged is treated as
 * the same entry with a new value, so it keeps its node — that is what makes
 * changing the ACME email keep the paragraph written above the email flag. Only
 * genuinely new names get a fresh node, appended at the end.
 */
function setList(doc: Stack, owner: YAMLMap, key: string, next: string[]): void {
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

/** A `--flag=value` / `label=value` entry's name, i.e. what makes two entries the
 *  same setting with different values. Valueless entries are their own name. */
function entryName(entry: string): string {
  const eq = entry.indexOf("=");
  return eq === -1 ? entry : entry.slice(0, eq);
}

/** Append one entry to a service list, creating the list if it has none. */
function addTo(doc: Stack, owner: YAMLMap, key: string, value: unknown): void {
  const node = owner.get(key, true);
  if (isSeq(node)) node.add(doc.createNode(value));
  else owner.set(key, doc.createNode([value]));
}

/**
 * The ACME resolver this stack actually defines, read off its own flags rather
 * than assumed. The installer names it `letsencrypt`, but a host configured for
 * DNS-01 against a different provider may not, and pointing the dashboard router
 * at a resolver that does not exist yields Traefik's self-signed default cert —
 * a browser warning on the page the operator just secured.
 */
function certResolver(command: string[]): string {
  for (const flag of command) {
    const m = flag.match(/^--certificatesresolvers\.([^.]+)\./);
    if (m) return m[1];
  }
  return "letsencrypt";
}

/**
 * Our labels, identified by router/middleware name — the removal marker.
 * `traefik.enable` is excluded on purpose: it is shared with any route the
 * operator added to this same container, so who owns it is decided by the
 * caller, not by the name.
 */
function isOurs(label: string): boolean {
  return (
    label.startsWith(`traefik.http.routers.${ROUTER}.`) ||
    label.startsWith(`traefik.http.middlewares.${AUTH_MIDDLEWARE}.`) ||
    label === FLAG_MARKER
  );
}

function dump(doc: Stack): string {
  // lineWidth 0 disables folding — a wrapped basicauth hash or a wrapped
  // `Host(...)` rule is still valid YAML but unreadable in the file the operator
  // may end up looking at on the host.
  return doc.toString({ lineWidth: 0 });
}
