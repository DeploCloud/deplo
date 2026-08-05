import yaml from "js-yaml";

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

  const command = asList(service.command);
  const labels = asList(service.labels);

  // Our own labels always go first, so enabling twice is idempotent and
  // disabling leaves whatever the operator added untouched. `traefik.enable` is
  // deliberately NOT treated as ours here — see the disable branch.
  const kept = labels.filter((l) => !isOurs(l) && !l.startsWith("traefik.enable="));

  if (!dashboard) {
    service.command = command.filter((c) => c !== DASHBOARD_FLAG);
    // `traefik.enable=true` is ours only when nothing else on this container
    // needs it. The installer's Traefik carries no labels at all, so an orphan
    // enable is our leftover — but an operator who added their own route to this
    // container still needs it, and removing it would silently unpublish them.
    const needsEnable = kept.some((l) => l.startsWith("traefik."));
    setLabels(service, needsEnable ? ["traefik.enable=true", ...kept] : kept);
    return dump(doc);
  }

  const domain = dashboard.domain.trim().toLowerCase();
  if (!domain) throw new Error("A domain is required to publish the Traefik dashboard");
  if (!dashboard.htpasswdUsers.trim())
    throw new Error("Credentials are required to publish the Traefik dashboard");

  if (!command.includes(DASHBOARD_FLAG)) command.push(DASHBOARD_FLAG);
  service.command = command;

  setLabels(service, [
    "traefik.enable=true",
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
    command = asList(traefikService(parseCompose(currentYaml)).command);
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
  const command = asList(service.command);
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
  service.command = next;
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
 * file, the same read-live-not-stored rule the ACME email follows, so a host
 * someone edited by hand reports what it is actually serving.
 */
export function traefikCertificates(currentYaml: string): CustomCertificate[] {
  let doc: ComposeDoc;
  try {
    doc = parseCompose(currentYaml);
  } catch {
    return [];
  }
  const content = topLevelConfigs(doc)[CERT_CONFIG];
  const text =
    content && typeof content === "object"
      ? (content as { content?: unknown }).content
      : undefined;
  if (typeof text !== "string") return [];
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
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
 * container. Both ride in the stack file itself: a compose `configs` entry with
 * inline `content`, which Docker materialises into the container on `up`. That
 * is deliberate: the agent has no RPC that writes an arbitrary path on the host
 * (ADR-0006 keeps host writes to the ones it exposes), and the stack file is
 * something Deplo is already allowed to rewrite. The PEM goes in verbatim:
 * Traefik's `certFile`/`keyFile` take either a path or the certificate itself.
 *
 * Known ceiling: the key therefore lives in that stack file, which the agent
 * writes 0644 (its acme.json is 0600). On a box with untrusted local users that
 * is weaker than it should be, and tightening it is an agent-side change
 * (hostops.go), not something this renderer can decide.
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
  const command = asList(service.command);

  // Ours always comes off first, so installing twice replaces rather than stacks.
  const otherConfigs = withoutOurConfig(service.configs);
  const otherTopLevel = { ...topLevelConfigs(doc) };
  delete otherTopLevel[CERT_CONFIG];

  if (certificates.length === 0) {
    // The flags come out only when they are ours. An operator who pointed the
    // file provider somewhere of their own keeps it: removing our certificates
    // must not unload their middlewares along with them.
    service.command = ourDynamicDir(command)
      ? command.filter(
          (c) => c !== `${FILE_DIRECTORY_FLAG}${DEPLO_DYNAMIC_DIR}` && c !== FILE_WATCH_FLAG,
        )
      : command;
    setConfigs(service, doc, otherConfigs, otherTopLevel);
    return dump(doc);
  }

  const existingDir = fileProviderDir(command);
  if (!existingDir) {
    command.push(`${FILE_DIRECTORY_FLAG}${DEPLO_DYNAMIC_DIR}`, FILE_WATCH_FLAG);
    service.command = command;
  }
  const dir = existingDir ?? DEPLO_DYNAMIC_DIR;

  setConfigs(
    service,
    doc,
    [...otherConfigs, { source: CERT_CONFIG, target: `${dir}/${CERT_FILE}` }],
    {
      ...otherTopLevel,
      [CERT_CONFIG]: {
        content: yaml.dump(
          {
            tls: {
              certificates: certificates.map((c) => ({
                certFile: c.certPem,
                keyFile: c.keyPem,
              })),
            },
          },
          { lineWidth: -1, noRefs: true },
        ),
      },
    },
  );
  return dump(doc);
}

/** The file provider's directory when the stack already declares one. Throws for
 *  a provider pinned to one filename (see withTraefikCertificates). */
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

function topLevelConfigs(doc: ComposeDoc): Record<string, unknown> {
  const configs = doc.configs;
  return configs && typeof configs === "object" && !Array.isArray(configs)
    ? (configs as Record<string, unknown>)
    : {};
}

/** Every config on the service EXCEPT ours, in either compose syntax. */
function withoutOurConfig(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) =>
    typeof entry === "string"
      ? entry !== CERT_CONFIG
      : !(
          entry &&
          typeof entry === "object" &&
          (entry as { source?: unknown }).source === CERT_CONFIG
        ),
  );
}

function setConfigs(
  service: ComposeService,
  doc: ComposeDoc,
  serviceConfigs: unknown[],
  topLevel: Record<string, unknown>,
): void {
  if (serviceConfigs.length === 0) delete service.configs;
  else service.configs = serviceConfigs;
  if (Object.keys(topLevel).length === 0) delete doc.configs;
  else doc.configs = topLevel;
}

/** Whether this stack currently publishes the dashboard, and on which host. */
export function traefikDashboardDomain(currentYaml: string): string | null {
  let doc: ComposeDoc;
  try {
    doc = parseCompose(currentYaml);
  } catch {
    return null;
  }
  const service = doc.services?.[traefikServiceName(doc) ?? ""];
  if (!service) return null;
  if (!asList(service.command).includes(DASHBOARD_FLAG)) return null;
  for (const label of asList(service.labels)) {
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

type ComposeService = {
  image?: string;
  container_name?: string;
  command?: unknown;
  labels?: unknown;
  [k: string]: unknown;
};
type ComposeDoc = { services?: Record<string, ComposeService>; [k: string]: unknown };

function parseCompose(text: string): ComposeDoc {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new Error(
      `Could not read this server's Traefik configuration: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("This server's Traefik configuration is not a compose file");
  return doc as ComposeDoc;
}

/**
 * The service key holding Traefik. Matched by container_name first (the
 * installer pins `deplo-traefik`), then by image, then by the conventional
 * `traefik` key — so a hand-renamed service still resolves.
 */
function traefikServiceName(doc: ComposeDoc): string | null {
  const services = doc.services ?? {};
  for (const [name, svc] of Object.entries(services)) {
    if (svc?.container_name === TRAEFIK_CONTAINER) return name;
  }
  for (const [name, svc] of Object.entries(services)) {
    if (typeof svc?.image === "string" && svc.image.toLowerCase().includes("traefik"))
      return name;
  }
  return services.traefik ? "traefik" : null;
}

function traefikService(doc: ComposeDoc): ComposeService {
  const name = traefikServiceName(doc);
  const service = name ? doc.services?.[name] : undefined;
  if (!service)
    throw new Error("This server's Traefik configuration has no Traefik service in it");
  return service;
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
    label.startsWith(`traefik.http.middlewares.${AUTH_MIDDLEWARE}.`)
  );
}

/**
 * compose accepts `labels`/`command` as either a list or a map (`KEY: value`).
 * Everything here works on the list form, which is also what the installer
 * writes and what every other Deplo renderer emits.
 */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value && typeof value === "object")
    return Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}=${String(v)}`,
    );
  if (typeof value === "string") return [value];
  return [];
}

function setLabels(service: ComposeService, labels: string[]): void {
  if (labels.length === 0) delete service.labels;
  else service.labels = labels;
}

function dump(doc: ComposeDoc): string {
  // lineWidth: -1 disables folding — a wrapped basicauth hash or a wrapped
  // `Host(...)` rule is still valid YAML but unreadable in the file the operator
  // may end up looking at on the host.
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}
