/**
 * Client-safe docker-compose linter for the Compose editor.
 *
 * Deplo post-processes every compose file before it deploys it (see
 * `compose-stack.ts`): it joins the exposed service to the external `deplo`
 * network, adds Traefik routing labels (leaving published `ports:` intact), and
 * strips `container_name`. The linter's job is to catch the
 * mistakes that break that pipeline — and the everyday compose mistakes users
 * make — BEFORE they hit save, with a line number for each.
 *
 * It runs in the browser (no `server-only`, only `js-yaml`, which is already a
 * dependency). The server still validates authoritatively at deploy time; this
 * is fast feedback, not a security boundary.
 */

import yaml from "js-yaml";

export type LintSeverity = "error" | "warning" | "info";

export interface LintDiagnostic {
  severity: LintSeverity;
  message: string;
  /** Stable rule id, useful for tests and suppression. */
  rule: string;
  /** 1-based line the marker attaches to (best-effort for semantic rules). */
  line: number;
  /** 1-based column, when known. */
  column?: number;
}

/** A js-yaml load error carries a `.mark` with 0-based line/column. */
interface YamlMark {
  line: number;
  column: number;
}
function markOf(e: unknown): YamlMark | null {
  if (e && typeof e === "object" && "mark" in e) {
    const mark = (e as { mark?: { line?: number; column?: number } }).mark;
    if (mark && typeof mark.line === "number") {
      return { line: mark.line, column: mark.column ?? 0 };
    }
  }
  return null;
}

/**
 * Find the 1-based line a top-level `services:` child key is declared on, by a
 * shallow scan of the source. js-yaml v4 drops per-node position info in the
 * high-level API, so for semantic rules we locate the service block textually.
 * Returns 1 when not found (so a marker still appears somewhere sane).
 */
function lineOfAppKey(lines: string[], service: string): number {
  // App keys are indented under `services:` — typically 2 spaces. Match a
  // line like `  app:` allowing any leading indentation of 1+ spaces.
  const re = new RegExp(`^\\s+${escapeRe(service)}\\s*:\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}

/** Find the line of a `key:` within a service block (best-effort). */
function lineOfServiceField(
  lines: string[],
  appLine: number,
  field: string,
): number {
  // Scan from the service line until indentation returns to the service's level
  // or shallower (next service / top-level), looking for `field:`.
  const startIdx = appLine - 1;
  const appIndent = leadingSpaces(lines[startIdx] ?? "");
  const re = new RegExp(`^(\\s+)${escapeRe(field)}\\s*:`);
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = leadingSpaces(line);
    if (indent <= appIndent) break; // left the service block
    const m = line.match(re);
    if (m && m[1].length > appIndent) return i + 1;
  }
  return appLine;
}

function leadingSpaces(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ComposeDoc = {
  services?: unknown;
  version?: unknown;
  [k: string]: unknown;
};

const VALID_RESTART = new Set([
  "no",
  "always",
  "on-failure",
  "unless-stopped",
]);

/** Lint a docker-compose document. Returns diagnostics ordered by line. */
export function lintCompose(source: string): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  const lines = source.split("\n");

  if (!source.trim()) {
    return [
      {
        severity: "error",
        rule: "empty",
        message: "Compose file is empty. Add a `services:` block to deploy.",
        line: 1,
      },
    ];
  }

  // 1. YAML must parse.
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(source) as ComposeDoc) ?? {};
  } catch (e) {
    const mark = markOf(e);
    const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
    // A tab in the indentation is the most common cryptic YAML failure — give a
    // direct fix instead of js-yaml's raw "bad indentation" wording.
    const isTab = /tab/i.test(message) || (mark != null && /\t/.test(lines[mark.line] ?? ""));
    return [
      {
        severity: "error",
        rule: isTab ? "indentation-tabs" : "yaml-parse",
        message: isTab
          ? "YAML doesn't allow tabs for indentation — use spaces."
          : `Invalid YAML: ${message}`,
        line: mark ? mark.line + 1 : 1,
        column: mark ? mark.column + 1 : undefined,
      },
    ];
  }

  // 2. Top level must be a mapping.
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return [
      {
        severity: "error",
        rule: "top-level-map",
        message: "Top level of a compose file must be a mapping (services, networks, …).",
        line: 1,
      },
    ];
  }

  // 3. `version:` is obsolete in Compose v2.
  if ("version" in doc) {
    diags.push({
      severity: "warning",
      rule: "obsolete-version",
      message: "`version` is obsolete in Compose v2 and is ignored. You can remove it.",
      line: lineOfTopKey(lines, "version"),
    });
  }

  // 4. `services:` must exist and be a non-empty mapping.
  const services = doc.services;
  if (services === undefined) {
    diags.push({
      severity: "error",
      rule: "no-services",
      message: "No `services:` defined. Deplo has nothing to deploy.",
      line: 1,
    });
    return sortDiags(diags);
  }
  if (services === null || typeof services !== "object" || Array.isArray(services)) {
    diags.push({
      severity: "error",
      rule: "services-shape",
      message: "`services:` must be a mapping of service-name → config.",
      line: lineOfTopKey(lines, "services"),
    });
    return sortDiags(diags);
  }
  const appEntries = Object.entries(services as Record<string, unknown>);
  if (appEntries.length === 0) {
    diags.push({
      severity: "error",
      rule: "empty-services",
      message: "`services:` is empty. Add at least one service.",
      line: lineOfTopKey(lines, "services"),
    });
    return sortDiags(diags);
  }

  // 5. Per-service checks.
  for (const [name, raw] of appEntries) {
    const svcLine = lineOfAppKey(lines, name);

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      diags.push({
        severity: "error",
        rule: "service-shape",
        message: `App \`${name}\` must be a mapping (image, ports, environment, …).`,
        line: svcLine,
      });
      continue;
    }
    const svc = raw as Record<string, unknown>;

    // image vs build
    const hasImage = typeof svc.image === "string" && svc.image.trim() !== "";
    const hasBuild =
      typeof svc.build === "string" ||
      (svc.build !== null && typeof svc.build === "object");
    if (!hasImage && !hasBuild) {
      diags.push({
        severity: "error",
        rule: "no-image-or-build",
        message: `App \`${name}\` has neither \`image:\` nor \`build:\`. It cannot start.`,
        line: svcLine,
      });
    }

    // image without an explicit tag → non-reproducible
    if (hasImage) {
      const image = (svc.image as string).trim();
      if (!hasExplicitTagOrDigest(image)) {
        diags.push({
          severity: "warning",
          rule: "image-untagged",
          message: `\`${name}\` pins no image tag, so it defaults to \`:latest\` — non-reproducible. Pin a version.`,
          line: lineOfServiceField(lines, svcLine, "image"),
        });
      }
    }

    // ports must be a list, not a scalar — the single most common mistake.
    if ("ports" in svc) {
      const ports = svc.ports;
      const portsLine = lineOfServiceField(lines, svcLine, "ports");
      if (!Array.isArray(ports)) {
        diags.push({
          severity: "error",
          rule: "ports-not-list",
          message: `\`${name}.ports\` must be a list, e.g.\n  ports:\n    - "8080:80"`,
          line: portsLine,
        });
      } else {
        for (const p of ports) {
          if (!isValidPortMapping(p)) {
            diags.push({
              severity: "warning",
              rule: "port-mapping",
              message: `\`${name}.ports\` entry \`${stringifyPort(p)}\` is not a valid port mapping (expected "HOST:CONTAINER" or a number).`,
              line: portsLine,
            });
          }
        }
      }
    }

    // environment: list of KEY=VALUE or a mapping
    checkListOrMap(svc, "environment", name, svcLine, lines, diags);
    // volumes: list
    checkList(svc, "volumes", name, svcLine, lines, diags);
    // networks: list or mapping. Load-bearing — Deplo's appNetworks() reads
    // this and a malformed value silently drops the service's real networks when
    // it attaches the `deplo` network.
    checkListOrMap(svc, "networks", name, svcLine, lines, diags);
    // labels: list or mapping. Load-bearing — mergeLabels() only handles those
    // two shapes; a scalar means Deplo's Traefik routing + tracking labels are
    // merged onto a broken base and the service loses routing/discovery.
    checkListOrMap(svc, "labels", name, svcLine, lines, diags);

    // depends_on: list of names or a mapping; flag unknown targets.
    if ("depends_on" in svc && svc.depends_on != null) {
      const dep = svc.depends_on;
      const depLine = lineOfServiceField(lines, svcLine, "depends_on");
      let targets: string[] = [];
      if (Array.isArray(dep)) targets = dep.map(String);
      else if (typeof dep === "object") targets = Object.keys(dep as object);
      else {
        diags.push({
          severity: "warning",
          rule: "depends-on-shape",
          message: `\`${name}.depends_on\` must be a list of service names or a mapping.`,
          line: depLine,
        });
      }
      const known = new Set(appEntries.map(([n]) => n));
      for (const dst of targets) {
        if (!known.has(dst)) {
          diags.push({
            severity: "warning",
            rule: "depends-on-unknown",
            message: `\`${name}\` depends on \`${dst}\`, which isn't a defined service.`,
            line: depLine,
          });
        }
      }
    }

    // Bind mounts: note the `./` convention, flag `..` escapes, and warn on
    // absolute host paths.
    if (Array.isArray(svc.volumes)) {
      const volLine = lineOfServiceField(lines, svcLine, "volumes");
      for (const v of svc.volumes) {
        const src = volumeSource(v);
        if (!src) continue;
        if (isFilesConventionSource(src)) {
          diags.push({
            severity: "info",
            rule: "bind-mount-files-note",
            message: `\`${name}\` mounts \`${src}\` — Deplo rewrites this to your project's isolated files directory at deploy time.`,
            line: volLine,
          });
        } else if (isEscapingSource(src)) {
          diags.push({
            severity: "warning",
            rule: "bind-mount-escapes-sandbox",
            message: `\`${name}\` mounts \`${src}\`, which uses \`..\` to climb out of your project's files directory. This is treated as a host bind mount and needs the host-volume permission. Use a \`./\`-relative path to stay inside the project.`,
            line: volLine,
          });
        } else if (src.startsWith("/")) {
          diags.push({
            severity: "warning",
            rule: "bind-mount-absolute",
            message: `\`${name}\` bind-mounts host path \`${src}\` — it must exist on the deploy host and isn't isolated per project. Prefer a Volume (storage deplo creates and keeps).`,
            line: volLine,
          });
        }
      }
    }

    // restart policy
    if ("restart" in svc) {
      const r = svc.restart;
      if (typeof r === "string" && !VALID_RESTART.has(r) && !r.startsWith("on-failure")) {
        diags.push({
          severity: "warning",
          rule: "restart-value",
          message: `\`${name}.restart\` = \`${r}\` is not a valid policy (no, always, on-failure, unless-stopped).`,
          line: lineOfServiceField(lines, svcLine, "restart"),
        });
      }
    }

    // --- Platform-specific (how Deplo will transform this) ---

    // container_name is stripped — let the user know it won't take effect.
    if ("container_name" in svc) {
      diags.push({
        severity: "info",
        rule: "container-name-stripped",
        message: `Deplo strips \`container_name\` (it would collide between services); \`${name}\` will use Compose's generated name.`,
        line: lineOfServiceField(lines, svcLine, "container_name"),
      });
    }

    // network_mode: host breaks Traefik routing.
    if (svc.network_mode === "host") {
      diags.push({
        severity: "warning",
        rule: "network-mode-host",
        message: `\`${name}\` uses \`network_mode: host\`, which bypasses the \`deplo\` network and Traefik routing. It won't be reachable via your domain.`,
        line: lineOfServiceField(lines, svcLine, "network_mode"),
      });
    }

    // Compose forbids combining network_mode with networks, and Deplo needs
    // `networks` to attach the deplo network.
    if ("network_mode" in svc && "networks" in svc && svc.networks != null) {
      diags.push({
        severity: "warning",
        rule: "network-mode-conflict",
        message: `\`${name}\` sets both \`network_mode\` and \`networks\` — Compose forbids combining them, and Deplo needs \`networks\` to attach the \`deplo\` network.`,
        line: lineOfServiceField(lines, svcLine, "network_mode"),
      });
    }

    // Anything that takes a container out of its sandbox. Gated server-side
    // behind the host-volume grant (see composeNeedsHostPrivileges and
    // composeMountsForeignStorage), so the message names the permission rather
    // than pretending it is only a smell.
    for (const key of hostPrivilegeKeys(svc)) {
      diags.push({
        severity: "warning",
        rule: "host-privileges",
        message: `\`${name}\` sets \`${key}\`, which takes the container out of its sandbox and gives it access to the server itself. This needs the host-volume permission.`,
        line: lineOfServiceField(lines, svcLine, key),
      });
    }
  }

  // Top-level volumes that point somewhere this app does not own. Same gate as
  // a host bind, so the message names the same permission — and it is a warning
  // rather than an error because it IS a legitimate operator action, just not a
  // team-level one.
  const topLevelVolumes =
    doc.volumes && typeof doc.volumes === "object" && !Array.isArray(doc.volumes)
      ? (doc.volumes as Record<string, unknown>)
      : {};
  for (const key of foreignVolumeKeys(topLevelVolumes)) {
    diags.push({
      severity: "warning",
      rule: "foreign-volume",
      message: `Volume \`${key}\` points at storage outside this app (an existing volume, or a path on the server). This needs the host-volume permission.`,
      line: lineOfTopKey(lines, "volumes"),
    });
  }

  // Top-level `secrets:`/`configs:` sourced from a host `file:` read that file
  // into the container — same host-file access as a service `env_file`, gated on
  // the same permission.
  for (const block of ["secrets", "configs"] as const) {
    const raw = doc[block];
    const map =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    for (const key of fileSourcedKeys(map)) {
      diags.push({
        severity: "warning",
        rule: "host-file-source",
        message: `\`${block}.${key}\` reads a file from the server into the container. This needs the host-volume permission.`,
        line: lineOfTopKey(lines, block),
      });
    }
  }

  return sortDiags(diags);
}

/** True if there are any blocking (error) diagnostics. */
export function hasBlockingErrors(diags: LintDiagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}

// --- helpers ---

function checkList(
  svc: Record<string, unknown>,
  key: string,
  name: string,
  svcLine: number,
  lines: string[],
  diags: LintDiagnostic[],
): void {
  if (key in svc && svc[key] != null && !Array.isArray(svc[key])) {
    diags.push({
      severity: "error",
      rule: `${key}-not-list`,
      message: `\`${name}.${key}\` must be a list.`,
      line: lineOfServiceField(lines, svcLine, key),
    });
  }
}

function checkListOrMap(
  svc: Record<string, unknown>,
  key: string,
  name: string,
  svcLine: number,
  lines: string[],
  diags: LintDiagnostic[],
): void {
  if (key in svc && svc[key] != null) {
    const v = svc[key];
    const ok = Array.isArray(v) || (typeof v === "object" && !Array.isArray(v));
    if (!ok) {
      diags.push({
        severity: "error",
        rule: `${key}-shape`,
        message: `\`${name}.${key}\` must be a list (\`- KEY=value\`) or a mapping.`,
        line: lineOfServiceField(lines, svcLine, key),
      });
    }
  }
}

/** Source side of a volume entry (short `src:dst` form or long `{source}`). */
export function volumeSource(v: unknown): string | null {
  if (typeof v === "string") {
    const idx = v.indexOf(":");
    return idx > 0 ? v.slice(0, idx) : null; // no ":" → a named/anonymous volume
  }
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (rec.type === "bind" && typeof rec.source === "string") return rec.source;
    if (typeof rec.source === "string" && rec.source.includes("/")) return rec.source;
  }
  return null;
}

/** The app-files `./<x>` convention is rewritten to the project's isolated
 * files directory at deploy time — NOT a host bind mount the user picked a path
 * for. Matches `./x`, `./folder/`, bare `.`/`./`; explicitly NOT `../` (escape). */
export function isFilesConventionSource(src: string): boolean {
  return /^\.(?:\/|$)/.test(src) && !isEscapingSource(src);
}

/**
 * True if a source climbs out of the project sandbox via a `..` path segment.
 * Such a source is never the app-files convention; it is treated as a host
 * bind (gated behind `canMountHostVolumes`) so a rename can't repoint it at
 * another project's data.
 */
export function isEscapingSource(src: string | null | undefined): boolean {
  return Boolean(src && src.split(/[\\/]/).includes(".."));
}

/**
 * True if a single compose volume entry bind-mounts a real HOST path — an
 * absolute source, OR a `..`-escaping source, that is NOT the project-isolated
 * `./...` convention. Shared by the editor lint (warning) and the server-side
 * permission gate so the two never disagree about what counts as a host mount.
 */
export function isHostBindSource(src: string | null | undefined): boolean {
  return Boolean(
    src &&
      (src.startsWith("/") || isEscapingSource(src)) &&
      !isFilesConventionSource(src),
  );
}

/** A docker-compose document, just the slice we read for host-bind / port
 * detection. */
interface ComposeDocShape {
  services?: Record<
    string,
    { volumes?: unknown; ports?: unknown; expose?: unknown } | null | undefined
  >;
}

/**
 * Parse a compose YAML string and report whether ANY service bind-mounts a host
 * path (see {@link isHostBindSource}). Used server-side to gate compose edits
 * behind the `canMountHostVolumes` grant. Tolerant of malformed input: a YAML it
 * can't parse, or a doc with no services, simply has no detectable host mount
 * (the real deploy-time parse/validate is the authoritative check).
 */
export function composeHasHostBindMount(composeYaml: string): boolean {
  let doc: ComposeDocShape | null;
  try {
    doc = yaml.load(composeYaml) as ComposeDocShape | null;
  } catch {
    return false;
  }
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

/**
 * The DNS names Deplo's own infrastructure answers to on the shared `deplo`
 * network. A container joining that network registers its SERVICE NAME as an
 * alias there, and Docker round-robins a name two containers both claim — so a
 * stack with one of these on that network takes over traffic meant for the
 * platform:
 *
 *  - `deplo` is where Traefik sends the PANEL (`DEFAULT_PANEL_TARGET` is
 *    `http://deplo:3000`), so claiming it collects admin session cookies;
 *  - `postgres` is the control plane's database on an install created before it
 *    moved to its own internal network, and what arrives on the first packet is
 *    the password in the connection string;
 *  - `traefik` / `deplo-traefik` are the proxy itself.
 *
 * The list is deliberately TINY, and the check only fires for a service that
 * actually joins the shared network: a stack with its own `postgres` service on
 * its own network is the most ordinary compose file there is, and refusing it
 * would be absurd.
 */
export const RESERVED_SHARED_NETWORK_NAMES = new Set([
  "deplo",
  "postgres",
  "traefik",
  "deplo-traefik",
]);

/** The shared network's name, as `compose-stack.ts` declares it. */
const SHARED_NETWORK = "deplo";

/**
 * Every top-level network KEY in this compose that resolves to the shared
 * network — which is not only the key `deplo`.
 *
 * Compose lets a network be referenced under any key while pointing at another
 * network by `name:`, so
 *
 *     networks: { sneaky: { external: true, name: deplo } }
 *
 * is the shared network under an alias of the author's choosing. Checking the
 * key alone is the same mistake as trusting an identifier that names itself:
 * every rule about the shared network has to resolve it by NAME first, or the
 * rule is one rename away from being decorative.
 *
 * Exported so the renderer and the editor agree on what "on the shared network"
 * means.
 */
export function sharedNetworkKeys(doc: {
  networks?: unknown;
}): Set<string> {
  const keys = new Set<string>([SHARED_NETWORK]);
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return keys;
  for (const [key, raw] of Object.entries(declared as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    const named =
      (typeof n.name === "string" && n.name.trim() === SHARED_NETWORK) ||
      (n.external != null &&
        typeof n.external === "object" &&
        !Array.isArray(n.external) &&
        (n.external as Record<string, unknown>).name === SHARED_NETWORK);
    if (named) keys.add(key);
  }
  return keys;
}

/** True when a service's `networks:` (either shape) joins the shared network,
 *  under whatever key it is referenced by. */
function joinsSharedNetwork(
  svc: Record<string, unknown>,
  shared: Set<string>,
): boolean {
  const n = svc.networks;
  if (Array.isArray(n)) return n.map(String).some((k) => shared.has(k));
  if (n && typeof n === "object")
    return Object.keys(n as object).some((k) => shared.has(k));
  return false;
}

/**
 * The first service in this compose that would claim a reserved infrastructure
 * name on the shared network, or null. See {@link RESERVED_SHARED_NETWORK_NAMES}.
 *
 * Only an EXPLICIT join is visible here (the authored compose has no routing
 * yet); a service that ends up on the shared network because a domain routes to
 * it is caught by the same rule in `buildComposeStack`, which sees the final
 * wiring. Two checks, one list.
 */
export function composeClaimsReservedName(composeYaml: string): string | null {
  let doc: { services?: Record<string, unknown>; networks?: unknown } | null;
  try {
    doc = yaml.load(composeYaml) as {
      services?: Record<string, unknown>;
      networks?: unknown;
    } | null;
  } catch {
    return null;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return null;
  const shared = sharedNetworkKeys(doc ?? {});
  for (const [name, raw] of Object.entries(services)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (
      RESERVED_SHARED_NETWORK_NAMES.has(name) &&
      joinsSharedNetwork(raw as Record<string, unknown>, shared)
    )
      return name;
  }
  return null;
}

/** The message both checks use, so the editor and the deploy say the same thing. */
export function reservedNameMessage(service: string): string {
  return (
    `The service \`${service}\` can't be on Deplo's shared network under that name — ` +
    `it is the name the platform itself answers to there, and two containers ` +
    `claiming one name split the traffic between them. Rename the service, or ` +
    `take it off the \`deplo\` network.`
  );
}

/**
 * Whether a TOP-LEVEL `volumes:` entry points at storage Deplo did not create
 * for this app — the other half of the host-volume permission, and the half no
 * check used to look at.
 *
 * `composeHasHostBindMount` reads the SERVICE mount list and calls a source a
 * host bind when it starts with `/` or climbs with `..`. Neither is true of a
 * NAMED volume, so the whole of this block was ungated, and it carries two ways
 * out of the app's own storage:
 *
 *  - `external: true` (or a pinned `name:`) attaches an EXISTING docker volume
 *    by its host name. The names are deterministic (`deplo-<slug>-<volume>`, and
 *    the control plane's own `…_deplo-postgres`), so this reached another team's
 *    data and the control-plane DATABASE at rest - every ciphertext, every
 *    session row, and write access to `users.is_instance_admin`.
 *  - `driver_opts: {type: none, device: /, o: bind}` is a bind mount of any host
 *    path, declared one level up from where the bind check was looking.
 *
 * Both are legitimate operator things to do - `appMoveVolumeNames` already
 * treats an `external:` volume as "storage the operator owns, not ours" - which
 * is exactly why they belong behind `canMountHostVolumes` rather than being
 * refused outright.
 *
 * Read on the AUTHORED compose, never the rendered one: Deplo injects its own
 * `{ name: deplo-<deployKey>-<volume> }` entries at render time, well after this
 * runs, so a plain `volumes: { data: {} }` (an ordinary per-app volume) stays
 * free and only a user-pinned target counts.
 */
function foreignVolumeKeys(volumes: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(volumes)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const v = raw as Record<string, unknown>;
    const external = v.external;
    const pinned =
      (external != null && external !== false) ||
      (typeof v.name === "string" && v.name.trim() !== "") ||
      (v.driver_opts != null &&
        typeof v.driver_opts === "object" &&
        Object.keys(v.driver_opts as object).length > 0);
    if (pinned) out.push(key);
  }
  return out;
}

/**
 * Top-level `secrets:`/`configs:` keys whose source is a host FILE (`file: …`).
 * Docker mounts that file into the container (at `/run/secrets|configs/<key>`);
 * the path resolves against the SHARED stack directory on the host, so even a
 * relative name reaches another tenant's rendered env-file — the same host-file
 * read as a service `env_file`, one level up. Gated the same way. An
 * `environment:`-sourced secret carries no host path and is left alone.
 */
function fileSourcedKeys(entries: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.file === "string" && v.file.trim() !== "") out.push(key);
  }
  return out;
}

/**
 * Parse a compose YAML string and report whether it points at storage or host
 * FILES this app does not own: a top-level `volumes:` entry pinned to a foreign
 * volume/host path ({@link foreignVolumeKeys}), OR a top-level `secrets:`/
 * `configs:` entry sourced from a host `file:` ({@link fileSourcedKeys}). Gated
 * server-side behind `canMountHostVolumes`, beside its siblings.
 *
 * Tolerant of malformed input, like the others: the deploy-time parse is the
 * authoritative one.
 */
export function composeMountsForeignStorage(composeYaml: string): boolean {
  let doc:
    | {
        volumes?: Record<string, unknown>;
        secrets?: Record<string, unknown>;
        configs?: Record<string, unknown>;
      }
    | null;
  try {
    doc = yaml.load(composeYaml) as typeof doc;
  } catch {
    return false;
  }
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

/**
 * Compose keys that hand a container the host, and how to tell they are ON.
 *
 * A bind mount of `/var/run/docker.sock` was already gated ({@link isHostBindSource});
 * every key here is another way to the same place, and none of them is a volume:
 * `privileged` alone is enough to mount the host's disk and chroot into it,
 * `pid: host` puts `nsenter -t 1` one command away, `devices` hands over a raw
 * disk, and `cap_add`/`security_opt`/`userns_mode` remove the boundary a step at
 * a time. They are therefore the same permission ({@link composeNeedsHostPrivileges}).
 *
 * `network_mode: host` is included: the host network namespace lets a container
 * bind arbitrary host ports and reach `127.0.0.1` host services (the control
 * plane, other stacks' internal ports), so it reaches past its own boundary like
 * the rest. `network_mode: container:<name>` joins another container's namespace
 * the same way. It ALSO costs the container its Traefik routing — the linter's
 * separate `network-mode-host` warning still says so; both fire.
 *
 * `cgroup: host` shares the host's cgroup namespace (like `pid`/`ipc`).
 * `volumes_from: "container:<name>"` mounts ANOTHER container's volumes on the
 * same daemon — the reference is by container NAME, so it ignores the network
 * split and reaches another tenant's data (and the control-plane database volume
 * at rest); a bare service name is same-stack and left alone. `env_file` reads a
 * host file into the container's environment, and its paths resolve against the
 * SHARED stack directory on the host (`/data/stacks`), so even a relative name
 * reaches another tenant's rendered env-file — any non-empty value is gated. The
 * `file:`-sourced half of the top-level `secrets:`/`configs:` blocks is the same
 * host-file read one level up, handled in {@link composeMountsForeignStorage}.
 */
const HOST_PRIVILEGE_KEYS = [
  "privileged",
  "cap_add",
  "devices",
  "device_cgroup_rules",
  "security_opt",
  "cgroup_parent",
  "pid",
  "ipc",
  "uts",
  "network_mode",
  "cgroup",
  "volumes_from",
  "env_file",
  "userns_mode",
] as const;

/**
 * `security_opt` entries that only ever make a container SAFER, and so are not
 * gated. Everything else there (`apparmor:unconfined`, `seccomp:unconfined`,
 * `label:disable`, a hand-written seccomp profile) removes a boundary.
 *
 * `no-new-privileges` is the one people actually write, and refusing it would
 * mean asking an admin for the host permission in order to HARDEN a container —
 * a gate that punishes the right thing teaches people to skip it.
 *
 * `cap_drop` and `read_only` are not on the list at all, for the same reason.
 */
const SAFE_SECURITY_OPTS = /^no-new-privileges\b/i;

/**
 * The keys of {@link HOST_PRIVILEGE_KEYS} this service actually sets, in
 * declaration order. Shared by the editor lint and the server-side gate so the
 * two can never disagree about what counts.
 *
 * A key present but empty (`cap_add: []`, `privileged: false`) declares nothing
 * and does not count - the same rule `composePublishesPorts` applies to `ports`.
 * `pid`/`ipc`/`uts`/`network_mode`/`cgroup` are namespace SELECTORS rather than
 * switches: `host` shares the host namespace, and `container:<name>`/
 * `service:<name>` join ANOTHER container's namespace on the same daemon (not
 * limited to this stack) — both escape, so both are flagged. An ordinary value (a
 * bridge network name, a real hostname for uts, `cgroup: private`) is left alone.
 * `volumes_from` flags only the `container:<name>` form (a foreign container's
 * volumes); `env_file` flags any non-empty value (it reads a host file).
 */
function hostPrivilegeKeys(svc: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of HOST_PRIVILEGE_KEYS) {
    const v = svc[key];
    if (v == null) continue;
    if (key === "privileged") {
      if (v === true) out.push(key);
      continue;
    }
    if (
      key === "pid" ||
      key === "ipc" ||
      key === "uts" ||
      key === "network_mode" ||
      key === "cgroup"
    ) {
      if (typeof v === "string") {
        const val = v.trim().toLowerCase();
        // `host` shares the host namespace; `container:`/`service:` joins ANOTHER
        // container's namespace on the same daemon (not limited to this stack).
        if (val === "host" || val.startsWith("container:") || val.startsWith("service:"))
          out.push(key);
      }
      continue;
    }
    if (key === "volumes_from") {
      // Mounts another container's volumes. `container:<name>` names a container
      // OUTSIDE this stack (another tenant's, or the platform's) — the escape;
      // a bare service name is same-stack and left alone.
      const list = Array.isArray(v) ? v : [v];
      if (
        list.some(
          (e) =>
            typeof e === "string" &&
            e.trim().toLowerCase().startsWith("container:"),
        )
      )
        out.push(key);
      continue;
    }
    if (key === "env_file") {
      // Any non-empty value reads a host file into the container's env; the path
      // resolves against the shared stack dir, so a bare name is cross-tenant.
      const list = Array.isArray(v) ? v : [v];
      const names = list.map((e) =>
        e && typeof e === "object"
          ? String((e as Record<string, unknown>).path ?? "")
          : String(e),
      );
      if (names.some((n) => n.trim() !== "")) out.push(key);
      continue;
    }
    if (key === "security_opt") {
      const weakening = Array.isArray(v)
        ? v.filter((o) => !SAFE_SECURITY_OPTS.test(String(o).trim()))
        : [v];
      if (weakening.length > 0) out.push(key);
      continue;
    }
    if (Array.isArray(v) ? v.length > 0 : typeof v === "object" || String(v).trim() !== "")
      out.push(key);
  }
  return out;
}

/**
 * Parse a compose YAML string and report whether ANY service asks for host
 * privileges (see {@link HOST_PRIVILEGE_KEYS}). Used server-side to gate compose
 * edits behind `canMountHostVolumes`, exactly like {@link composeHasHostBindMount}
 * — and for the same reason: both are a container reaching past its own boundary,
 * and a permission that stops one while allowing the other stops nothing.
 *
 * Tolerant of malformed input, like its two siblings: the deploy-time parse is
 * the authoritative one.
 */
export function composeNeedsHostPrivileges(composeYaml: string): boolean {
  let doc: { services?: Record<string, unknown> } | null;
  try {
    doc = yaml.load(composeYaml) as { services?: Record<string, unknown> } | null;
  } catch {
    return false;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return false;
  for (const svc of Object.values(services)) {
    if (!svc || typeof svc !== "object" || Array.isArray(svc)) continue;
    if (hostPrivilegeKeys(svc as Record<string, unknown>).length > 0) return true;
  }
  return false;
}

/**
 * Parse a compose YAML string and report whether ANY service publishes ports —
 * either host-published `ports:` (mapped onto the server's IP/port) or `expose:`
 * (advertised to other containers). Used server-side to gate compose edits
 * behind the `canExposePorts` grant. This is independent of Traefik routing:
 * giving a service a public DOMAIN does NOT publish a port and is never gated
 * here — only a `ports:`/`expose:` declaration in the compose itself is.
 *
 * Tolerant of malformed input: YAML it can't parse, or a doc with no services,
 * has no detectable published port (the deploy-time parse is authoritative). A
 * `ports:`/`expose:` key present but empty (`[]`/null) declares nothing, so it
 * does not count.
 */
export function composePublishesPorts(composeYaml: string): boolean {
  let doc: ComposeDocShape | null;
  try {
    doc = yaml.load(composeYaml) as ComposeDocShape | null;
  } catch {
    return false;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return false;
  for (const svc of Object.values(services)) {
    // Host-published mappings: any well-formed entry counts.
    const ports = svc?.ports;
    if (Array.isArray(ports) && ports.some(isValidPortMapping)) return true;
    // `expose:` is a list of container ports advertised to linked services.
    const expose = svc?.expose;
    if (Array.isArray(expose) && expose.length > 0) return true;
  }
  return false;
}

function hasExplicitTagOrDigest(image: string): boolean {
  if (image.includes("@")) return true; // digest pin
  // Strip a registry host (which may contain a port colon) before checking for
  // a tag colon. The last path component holds the tag.
  const lastSlash = image.lastIndexOf("/");
  const lastComponent = lastSlash === -1 ? image : image.slice(lastSlash + 1);
  return lastComponent.includes(":");
}

function isValidPortMapping(p: unknown): boolean {
  if (typeof p === "number") return p > 0 && p < 65536;
  if (typeof p === "string") {
    // "8080:80", "8080:80/tcp", "127.0.0.1:8080:80", "80", "8000-8010:8000-8010"
    return /^(\d{1,3}(\.\d{1,3}){3}:)?[\d-]+(:[\d-]+){0,2}(\/(tcp|udp))?$/.test(
      p.trim(),
    );
  }
  if (p && typeof p === "object") {
    // long form { target, published, protocol }
    return "target" in (p as object);
  }
  return false;
}

function stringifyPort(p: unknown): string {
  if (typeof p === "string" || typeof p === "number") return String(p);
  return JSON.stringify(p);
}

/** Line of a top-level key like `version:` or `services:`. */
function lineOfTopKey(lines: string[], key: string): number {
  const re = new RegExp(`^${escapeRe(key)}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}

function sortDiags(diags: LintDiagnostic[]): LintDiagnostic[] {
  return [...diags].sort((a, b) => a.line - b.line || severityRank(a.severity) - severityRank(b.severity));
}
function severityRank(s: LintSeverity): number {
  return s === "error" ? 0 : s === "warning" ? 1 : 2;
}
