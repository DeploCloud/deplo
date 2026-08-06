import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parse,
  parseDocument,
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
  withRedirectFallback(doc, service);

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
  const resolver = stackCertResolver(currentYaml);
  if (resolver === null) return null;
  const command = listOf(traefikService(parseCompose(currentYaml)).get("command", true));
  const flag = `--certificatesresolvers.${resolver}.acme.email=`;
  const found = command.find((c) => c.startsWith(flag));
  return found ? found.slice(flag.length) : "";
}

/**
 * The name of the ACME resolver this host actually defines, or null when it
 * defines none - a proxy that terminates TLS with certificates from elsewhere.
 *
 * Read off the host's own flags rather than assumed: the installer names it
 * `letsencrypt`, but a host configured for DNS-01 against another provider may
 * not, and pointing a router at a resolver that does not exist yields Traefik's
 * self-signed default - a browser warning on the page just secured.
 */
export function stackCertResolver(currentYaml: string): string | null {
  let command: string[];
  try {
    command = listOf(traefikService(parseCompose(currentYaml)).get("command", true));
  } catch {
    return null;
  }
  if (!command.some((c) => c.startsWith("--certificatesresolvers."))) return null;
  return certResolver(command);
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
  withRedirectFallback(doc, service);
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

/** Our compose configs, the files they become, and the directory we serve them from. */
const CERT_CONFIG = "deplo-certificates";
const CERT_FILE = "deplo-certificates.yml";
const PANEL_CONFIG = "deplo-panel";
const PANEL_FILE = "deplo-panel.yml";
/**
 * Every dynamic-config file Deplo owns. Membership decides one thing: whether
 * the file provider is still needed after one of them is removed. Taking the
 * flags out while another of ours is still mounted would unload it - which, for
 * the panel's own route, means unpublishing the page issuing the request.
 */
const OUR_CONFIGS = [CERT_CONFIG, PANEL_CONFIG];
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
 *
 * The file is mounted 0400 rather than compose's default 0444, because it holds
 * private keys and every process in that container can read a 0444 file.
 */
export function withTraefikCertificates(
  currentYaml: string,
  certificates: CustomCertificate[],
): string {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  withRedirectFallback(doc, service);

  // Read before dropping: our config file is a Traefik dynamic-config file like
  // any other, and an operator may have added a `tls.options` block or a
  // middleware to it. Only the certificates in it are ours to rewrite.
  const currentContent = doc.getIn(["configs", CERT_CONFIG, "content"]);

  // Ours always comes off first, so installing twice replaces rather than stacks.
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

/**
 * Our dynamic-config file: the current one with only its `tls.certificates`
 * replaced, or a fresh one when there is nothing readable to keep.
 *
 * Edited as a document for the same reason the stack file is (see the file
 * comment) - this one is a Traefik config an operator can hand-edit too, and
 * re-rendering it from the certificate list alone would delete whatever else
 * they put in it, silently, on the next install.
 */
function certificateFile(current: unknown, certificates: CustomCertificate[]): string {
  const entries = certificates.map((c) => ({ certFile: c.certPem, keyFile: c.keyPem }));
  const write = (doc: Document) => {
    doc.setIn(["tls", "certificates"], doc.createNode(entries));
    return doc.toString({ lineWidth: 0 });
  };
  if (typeof current === "string") {
    const parsed = parseDocument(current);
    if (parsed.errors.length === 0 && isMap(parsed.contents)) {
      try {
        return write(parsed);
      } catch {
        // Something in there is not the shape a Traefik config has - a `tls:`
        // holding a string, say. Nothing to preserve then, and a certificate
        // must still install: whatever was in the file was not working either.
      }
    }
  }
  return write(new Document({}));
}

/**
 * Mount one of our dynamic-config files into the host's Traefik, declaring the
 * file provider when the host has none.
 *
 * Both pieces are needed and neither can come from a label: Traefik reads
 * dynamic configuration only from its FILE provider, and the file has to exist
 * inside the container. Both ride in the stack file itself - a compose `configs`
 * entry with inline `content`, which Docker materialises on `up`. That is
 * deliberate: the agent has no RPC that writes an arbitrary path on the host
 * (ADR-0006 keeps host writes to the ones it exposes), and the stack file is
 * something Deplo is already allowed to rewrite.
 *
 * The operator's own file provider is respected when they have one: our file is
 * dropped into THEIR directory rather than a second provider being declared,
 * which Traefik would refuse.
 */
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
    // 0400, owned by root, which is who the official image runs Traefik as. A
    // stack the operator moved onto a `user:` of their own keeps compose's 0444
    // default instead: an unreadable certificate file is a proxy serving its
    // self-signed default, which is worse than a file only that container can see.
    //
    // Decimal because compose's YAML reader takes a bare `0400` as octal and this
    // one as the same number: 256 IS 0400, and it is the form that cannot be
    // misread whichever way the file is parsed later.
    ...(service.has("user") ? {} : { mode: 256 }),
  });
  doc.setIn(["configs", name], doc.createNode({ content }));
}

/**
 * Take the file provider back out, but only when it was ours AND nothing else of
 * ours still needs it.
 *
 * Two refusals in one: an operator who pointed the file provider somewhere of
 * their own keeps it (removing our certificates must not unload their
 * middlewares), and a second Deplo config still mounted keeps it too - stripping
 * the flags while the panel's own route lives in that directory would unpublish
 * the panel as a side effect of deleting a certificate.
 *
 * Call AFTER {@link dropOurConfig}, which is what makes "anything else of ours"
 * an honest question.
 */
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
      (c) => c !== `${FILE_DIRECTORY_FLAG}${DEPLO_DYNAMIC_DIR}` && c !== FILE_WATCH_FLAG,
    ),
  );
}

/** The file provider's directory when the stack already declares one. Throws for
 *  a provider pinned to one filename - see mountDeploConfig. */
function fileProviderDir(command: string[], purpose: string): string | null {
  if (command.some((c) => c.startsWith("--providers.file.filename=")))
    throw new Error(
      `This server's proxy loads a single Traefik configuration file, so Deplo cannot add ${purpose} alongside it. Point it at a directory (--providers.file.directory) instead.`,
    );
  const found = command.find((c) => c.startsWith(FILE_DIRECTORY_FLAG));
  return found ? found.slice(FILE_DIRECTORY_FLAG.length) : null;
}

/**
 * The operator's read-only mount that would swallow a file written into `dir`,
 * if there is one - its container path, so the message can name it.
 *
 * Compose materialises a `configs` entry as a bind mount of one FILE, and the
 * kernel needs that file to already exist inside whatever is mounted over its
 * parent. A parent the operator mounted `:ro` cannot get one, and the failure
 * lands on `up` - AFTER the old container is gone, so the host's proxy stays
 * down until someone with a shell fixes it, which is the trip Deplo exists to
 * remove. Refusing before the write is the whole difference between a sentence
 * and an outage. Verified against Docker, which answers:
 *   openat etc/traefik/dynamic/deplo-certificates.yml: read-only file system
 *
 * An ancestor counts, not just the directory itself: mounting `/etc/traefik:ro`
 * makes `/etc/traefik/dynamic` just as unwritable. Every other read-only mount
 * (the docker socket, an acme store) is somewhere else entirely and is none of
 * this function's business.
 */
function readOnlyMountOver(service: YAMLMap, dir: string): string | null {
  const mounts = service.get("volumes", true);
  if (!isSeq(mounts)) return null;
  for (const entry of mounts.items) {
    let target = "";
    let readOnly = false;
    if (isScalar(entry)) {
      // Short form: `source:target[:opts]`, where opts is a comma-separated list
      // that `ro` may share with others (`ro,z` on SELinux hosts).
      const parts = String(entry.value).split(":");
      if (parts.length < 2) continue;
      target = parts[1];
      readOnly = (parts[2] ?? "").split(",").includes("ro");
    } else if (isMap(entry)) {
      target = scalar(entry.get("target", true));
      readOnly = entry.get("read_only") === true;
    }
    if (readOnly && target && (dir === target || dir.startsWith(`${target}/`))) return target;
  }
  return null;
}

/**
 * Take one of our configs off both the service and the top level, in either
 * compose syntax, leaving every other entry — and the comments attached to them —
 * where they are.
 */
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

/** The config a service `configs` entry names, in either syntax (`- name` or
 *  `- source: name`). */
function configSource(entry: unknown): string {
  if (isScalar(entry)) return String(entry.value);
  if (isMap(entry)) return String(entry.get("source") ?? "");
  return "";
}

/* ------------------------------------------------------------------ */
/* The panel's own route                                               */
/* ------------------------------------------------------------------ */

/**
 * The router that publishes Deplo itself. Also the name of its service and the
 * key both live under in our dynamic-config file.
 */
const PANEL_ROUTER = "deplo-panel";

/**
 * How this host publishes the Deplo panel.
 *
 * `certResolver: null` is the opt-out: the router still terminates TLS, but no
 * certificate is ORDERED for it. Traefik then serves whatever matches from the
 * certificates the operator installed themselves, or its self-signed default -
 * which is exactly what a Cloudflare "Full" origin, a corporate proxy or an
 * internal CA in front of the panel wants, and what a domain Let's Encrypt
 * cannot validate (no public DNS, :80 closed) needs to stop retrying forever.
 */
export type PanelRoute = {
  /** The host the panel answers on. */
  domain: string;
  /** https on :443, or plain http on :80. */
  https: boolean;
  /** The ACME resolver its certificate is ordered from. Null = none, and
   *  meaningless when {@link https} is false. */
  certResolver: string | null;
  /** Where Traefik forwards, e.g. `http://deplo:3000`. Read live, never assumed. */
  target: string;
};

/**
 * The panel's router priority, and why it is 2 rather than 1.
 *
 * A whole-host router must stay a FALLBACK so an app's own route on the same
 * host outranks it, which is what a low number buys. But 1 is taken twice over:
 * it is where {@link withRedirectFallback} pins the entrypoint's
 * http-to-https redirect, and it is what a Deplo installed before this existed
 * pinned its own container LABEL router to. Sitting at 2 clears both - Traefik's
 * tie-break between equal priorities is not something to bet a panel on - and
 * still sits far below every real route: an app's Host() router gets its rule
 * LENGTH (tens), a PathPrefix router gets PATH_PRIORITY_BASE (a million).
 *
 * One number for both schemes, and the same one `install.sh` seeds, so the file
 * an operator reads on the host does not change under them on the first edit.
 */
const PANEL_PRIORITY = 2;

/** Where the entrypoint redirect is pinned so an explicit route can outrank it. */
const REDIRECT_PRIORITY = 1;

/**
 * Where the panel lives on a host `install.sh` set up: the control plane's own
 * compose service name, resolved by Docker DNS on the shared `deplo` network.
 *
 * Only ever a STARTING GUESS, for adopting a panel that predates Deplo owning
 * its own route. Every other path reads the target back out of the file, because
 * a Deplo running from source on the host is reached through the docker gateway
 * instead and re-rendering it from this constant would send every request into a
 * container that does not exist. The caller proves the guess answers before
 * writing it - see `adoptPanelRoute`.
 */
export const DEFAULT_PANEL_TARGET = "http://deplo:3000";

/**
 * The panel route this host serves, or null when Deplo does not own one.
 *
 * Null is a real answer, not a failure: a Deplo installed before this existed
 * publishes itself with labels on its own container, which is a file no agent
 * RPC can write - so the honest thing is to report that the route is not ours
 * rather than to write a second one that fights it.
 */
export function panelRoute(currentYaml: string): PanelRoute | null {
  let content: unknown;
  try {
    content = parseCompose(currentYaml).getIn(["configs", PANEL_CONFIG, "content"]);
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
  const http = (parsed as { http?: { routers?: Record<string, unknown>; services?: Record<string, unknown> } } | null)
    ?.http;
  const router = http?.routers?.[PANEL_ROUTER] as
    | { rule?: unknown; tls?: { certResolver?: unknown } }
    | undefined;
  const target = (
    http?.services?.[PANEL_ROUTER] as
      | { loadBalancer?: { servers?: { url?: unknown }[] } }
      | undefined
  )?.loadBalancer?.servers?.[0]?.url;
  if (!router || typeof target !== "string" || !target) return null;

  const rule = typeof router.rule === "string" ? router.rule.match(/^Host\(`([^`]+)`\)$/) : null;
  if (!rule) return null;
  const resolver = router.tls?.certResolver;
  return {
    domain: rule[1],
    // The presence of `tls` IS the answer: a router without it terminates
    // nothing, which is what plain http means here.
    https: router.tls !== undefined && router.tls !== null,
    certResolver: typeof resolver === "string" && resolver ? resolver : null,
    target,
  };
}

/**
 * Publish the Deplo panel on this host's proxy (or, with `null`, stop).
 *
 * The route is a FILE, not labels on the panel's own container, and that is the
 * whole point: the container's compose file belongs to the installer and no
 * agent RPC can rewrite it, so a panel published by labels can never be changed
 * from the panel. A dynamic-config file is something Deplo is already allowed to
 * write (see {@link withTraefikCertificates}).
 *
 * It rides in the stack file as a compose `config`, so applying one DOES recreate
 * the proxy: the same few seconds of interruption installing a certificate costs,
 * for every site on that host and not only the panel. Traefik watches the
 * directory, so an operator editing the file ON the host gets a hot reload -
 * Deplo, writing it through the agent, does not. Callers must say so.
 *
 * `priority: 1` for the reason `install.sh` pinned the label router to 1: this
 * is a whole-host rule, and Traefik's default priority is the rule's LENGTH, so
 * an app's `PathPrefix` route on the same host would otherwise be swallowed by
 * the panel. See `routing.ts` → PATH_PRIORITY_BASE.
 *
 * A plain-http route also pins the entrypoint redirect
 * ({@link withRedirectFallback}), without which it would not be reachable at
 * all - measured, not assumed: an entrypoint redirection outranks EVERY router
 * on that entrypoint, including one at priority MaxInt32.
 */
export function withPanelRoute(currentYaml: string, route: PanelRoute | null): string {
  const doc = parseCompose(currentYaml);
  const service = traefikService(doc);
  withRedirectFallback(doc, service);

  // Read before dropping, same as the certificates: the file is a Traefik config
  // like any other and an operator may have put a middleware of their own in it.
  const currentContent = doc.getIn(["configs", PANEL_CONFIG, "content"]);
  dropOurConfig(doc, service, PANEL_CONFIG);

  if (!route) {
    dropFileProvider(doc, service, PANEL_CONFIG);
    return dump(doc);
  }

  const domain = route.domain.trim().toLowerCase();
  if (!domain) throw new Error("A domain is required to publish the Deplo panel");
  const target = route.target.trim();
  if (!target)
    throw new Error("Deplo does not know where its proxy should send the panel on this server");

  mountDeploConfig(
    doc,
    service,
    PANEL_CONFIG,
    PANEL_FILE,
    "the panel's own route",
    panelFile(currentContent, { ...route, domain, target }),
  );
  return dump(doc);
}

/**
 * Our dynamic-config file for the panel: the current one with only OUR router
 * and service replaced, for the same reason {@link certificateFile} preserves
 * the rest - an operator who added a middleware to it keeps it.
 */
function panelFile(current: unknown, route: PanelRoute): string {
  const write = (doc: Document) => {
    doc.setIn(
      ["http", "routers", PANEL_ROUTER],
      doc.createNode({
        rule: `Host(\`${route.domain}\`)`,
        entryPoints: [route.https ? "websecure" : "web"],
        service: PANEL_ROUTER,
        priority: PANEL_PRIORITY,
        // No `tls` key at all on http - its absence is what makes the route
        // plain. On https, `{}` when the host names no resolver: the router
        // still terminates and serves a certificate the operator installed,
        // instead of ordering one from a resolver that does not exist.
        ...(route.https
          ? { tls: route.certResolver ? { certResolver: route.certResolver } : {} }
          : {}),
      }),
    );
    doc.setIn(
      ["http", "services", PANEL_ROUTER],
      doc.createNode({
        loadBalancer: { servers: [{ url: route.target }], passHostHeader: true },
      }),
    );
    return doc.toString({ lineWidth: 0 });
  };
  if (typeof current === "string") {
    const parsed = parseDocument(current);
    if (parsed.errors.length === 0 && isMap(parsed.contents)) {
      try {
        return write(parsed);
      } catch {
        // Not the shape a Traefik config has. Nothing to preserve then, and the
        // panel must still be routed: whatever was in there was not working.
      }
    }
  }
  return write(new Document({}));
}

/**
 * Pin this host's http-to-https entrypoint redirect BELOW the routes on it, so a
 * route that asks for plain http is actually served over plain http.
 *
 * Traefik implements `entryPoints.web.http.redirections` as a router of its own,
 * at a priority no route can outrank - measured on traefik:v3.7, where a router
 * pinned to MaxInt32 was still answered with a 301. The only lever is the
 * redirection's OWN `priority`, and dropping it to {@link REDIRECT_PRIORITY}
 * leaves the redirect doing exactly its job: a host with no route of its own
 * still goes to https, while a host that HAS one is served.
 *
 * That is not only the panel's problem, and it is why this runs on EVERY write
 * this module makes rather than only when publishing an http panel. Every domain
 * on the `none` certificate provider - the DEFAULT for a new domain - renders a
 * router on the `web` entrypoint (`domainTlsConfig`), so on a stock install
 * every plain-http app URL Deplo hands out was being redirected to an https it
 * has no certificate for. The installers now write the flag, but a host set up
 * before that keeps the bug until something rewrites its stack; making every
 * rewrite carry the fix means an existing fleet heals on the next ordinary
 * action (a certificate, the account email, the dashboard) instead of needing
 * every host re-installed by hand.
 *
 * Never taken back out: the routes that depend on it are exactly the routes
 * Deplo renders, and removing it would silently un-serve them.
 *
 * An explicit priority the operator set themselves is left alone: they have
 * ordered their own entrypoint on purpose.
 */
function withRedirectFallback(doc: Stack, service: YAMLMap): void {
  const command = listOf(service.get("command", true));
  const redirection = command.find((c) =>
    /^--entrypoints\.[^.]+\.http\.redirections\.entrypoint\.to=/.test(c),
  );
  if (!redirection) return;
  const prefix = redirection.slice(0, redirection.indexOf(".to="));
  const priorityFlag = `${prefix}.priority=`;
  if (command.some((c) => c.startsWith(priorityFlag))) return;
  setList(doc, service, "command", [...command, `${priorityFlag}${REDIRECT_PRIORITY}`]);
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
