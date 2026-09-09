/**
 * Client-safe docker-compose linter for the Compose editor: the mistakes that
 * break Deplo's post-processing (see `compose-stack.ts`) plus the everyday ones,
 * with a line number. Fast feedback, not a boundary - the deploy re-validates.
 */

import yaml, { isMap, isScalar, Scalar, visit, type Document } from "../yaml";

import { isDatastoreImage } from "../databases/images";
import { INFRA_NETWORK, PLATFORM_NETWORKS, isTenantNetwork } from "./network";

/**
 * An `environment:` value is TEXT by the time the container reads it: `UMASK: 022`
 * parses to 22 and comes back `22`, `1.10` to `1.1`. Only `environment` - anywhere
 * else quoting a number would change what compose reads.
 */
export function keepAuthoredEnvText(doc: Document): boolean {
  let changed = false;
  visit(doc, {
    Pair(_key, pair) {
      const key = pair.key;
      if (!isScalar(key) || key.value !== "environment") return;
      if (!isMap(pair.value)) return;
      for (const item of pair.value.items) {
        const value = item.value;
        // A NUMBER only: a bare `true` or an empty value mean what they say, and
        // a string already carries its own text.
        if (!isScalar(value) || typeof value.value !== "number") continue;
        if (typeof value.source !== "string") continue;
        if (value.source === String(value.value)) continue;
        value.value = value.source;
        value.type = Scalar.QUOTE_SINGLE;
        changed = true;
      }
    },
  });
  return changed;
}

/**
 * Whether compose would substitute something into this value. `$$` is its escape,
 * so `$$HOME` interpolates nothing while `$HOME` and `${HOME}` both do.
 */
export function interpolates(value: string): boolean {
  return /(^|[^$])\$(\$\$)*[^$]/.test(`${value.trim()} `);
}

/** The same question for a value of any type: only a string can interpolate. */
export function isInterpolated(v: unknown): boolean {
  return typeof v === "string" && interpolates(v);
}

/**
 * Whether compose would read this value as TRUE. It casts to a typed bool, so the
 * YAML 1.1 spellings (`yes`, `on`, `y`) and a quoted `"true"` count - which is how
 * `privileged: yes` reached the host past a gate testing `=== true`.
 */
export function composeTruthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  return typeof v === "string" && /^(y|yes|true|on|1)$/i.test(v.trim());
}

export type LintSeverity = "error" | "warning" | "info";

/**
 * The rules that mean "this stack reaches the server itself". Named once so the
 * wizard can say so on the card - a template that mounts the Docker socket used
 * to be a one-click deploy with the warning two clicks away, under Advanced.
 */
export const HOST_ACCESS_RULES: readonly string[] = [
  "host-privileges",
  "foreign-volume",
  "bind-mount-absolute",
  "bind-mount-escapes-sandbox",
  "bind-mount-interpolated",
];

/** Does this stack need the host-volume grant? */
export function needsHostAccess(
  diagnostics: readonly { rule: string }[],
): boolean {
  return diagnostics.some((d) => HOST_ACCESS_RULES.includes(d.rule));
}

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
  // App keys are indented under `services:` - typically 2 spaces. Match a
  // line like `  app:` allowing any leading indentation of 1+ spaces.
  const re = new RegExp(`^\\s+${escapeRe(service)}\\s*:\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}

/** The `aliases:` a service asks for on any network, in either compose form. */
function svcNetworkAliases(svc: Record<string, unknown>): string[] {
  const nets = svc.networks;
  if (!nets || typeof nets !== "object" || Array.isArray(nets)) return [];
  const out: string[] = [];
  for (const entry of Object.values(nets as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const aliases = (entry as { aliases?: unknown }).aliases;
    if (Array.isArray(aliases)) out.push(...aliases.map(String));
  }
  return out;
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

const VALID_RESTART = new Set(["no", "always", "on-failure", "unless-stopped"]);

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
    // A tab in the indentation is the most common cryptic YAML failure - give a
    // direct fix instead of js-yaml's raw "bad indentation" wording.
    const isTab =
      /tab/i.test(message) ||
      (mark != null && /\t/.test(lines[mark.line] ?? ""));
    return [
      {
        severity: "error",
        rule: isTab ? "indentation-tabs" : "yaml-parse",
        message: isTab
          ? "YAML doesn't allow tabs for indentation - use spaces."
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
        message:
          "Top level of a compose file must be a mapping (services, networks, …).",
        line: 1,
      },
    ];
  }

  // 3. `version:` is obsolete in Compose v2.
  if ("version" in doc) {
    diags.push({
      severity: "warning",
      rule: "obsolete-version",
      message:
        "`version` is obsolete in Compose v2 and is ignored. You can remove it.",
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
  if (
    services === null ||
    typeof services !== "object" ||
    Array.isArray(services)
  ) {
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

    // A name Deplo's own infrastructure answers to on the shared network. It is
    // only REFUSED once the service is actually on that network (giving it a
    // domain is what puts it there), so a stack can be saved and imported with
    // one - and then fail its first deploy on a rule nothing had mentioned.
    const reservedClaim = serviceReservedClaim(name, svc);
    if (reservedClaim) {
      diags.push({
        severity: "warning",
        rule: "reserved-service-name",
        message: `\`${reservedClaim}\` is a name Deplo's own infrastructure uses. This service cannot be given a domain under it - rename it if it needs one.`,
        line: svcLine,
      });
    }

    // Aliases on the shared network are dropped at deploy: a container there
    // already answers to its service name, and a hand-written alias is a way to
    // claim any OTHER name on a network every app on the host shares. Said here
    // because the stack still deploys, so nothing else would ever mention it.
    if (svcNetworkAliases(svc).length > 0) {
      diags.push({
        severity: "warning",
        rule: "network-aliases-dropped",
        message: `\`${name}\` sets network aliases. Deplo removes them - other services reach it by its service name.`,
        line: lineOfServiceField(lines, svcLine, "networks"),
      });
    }

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
          message: `\`${name}\` pins no image tag, so it defaults to \`:latest\` - non-reproducible. Pin a version.`,
          line: lineOfServiceField(lines, svcLine, "image"),
        });
      }
    }

    // ports must be a list, not a scalar - the single most common mistake.
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
    // networks: list or mapping. Load-bearing - Deplo's appNetworks() reads
    // this and a malformed value silently drops the service's real networks when
    // it attaches the `deplo` network.
    checkListOrMap(svc, "networks", name, svcLine, lines, diags);
    // labels: list or mapping. Load-bearing - mergeLabels() only handles those
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
        // First: an interpolated source is none of the three shapes below, and the
        // save gates it as a host bind - the editor has to say so here, or the
        // refusal arrives out of nowhere.
        if (interpolates(src)) {
          diags.push({
            severity: "warning",
            rule: "bind-mount-interpolated",
            message: `\`${name}\` mounts \`${src}\`, whose path is filled in from a variable at \`compose up\`. Deplo can't tell where that points, so it counts as a host bind mount and needs the host-volume permission. Write the path here instead.`,
            line: volLine,
          });
        } else if (isFilesConventionSource(src)) {
          diags.push({
            severity: "info",
            rule: "bind-mount-files-note",
            message: `\`${name}\` mounts \`${src}\` - Deplo rewrites this to your project's isolated files directory at deploy time, and creates it there if it is missing: as a file when the name looks like one (config.yml), else as a folder.`,
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
            message: `\`${name}\` bind-mounts host path \`${src}\` - it must exist on the deploy host and isn't isolated per project. Prefer a Volume (storage Deplo creates and keeps).`,
            line: volLine,
          });
        }
      }
    }

    // restart policy
    if ("restart" in svc) {
      const r = svc.restart;
      if (
        typeof r === "string" &&
        !VALID_RESTART.has(r) &&
        !r.startsWith("on-failure")
      ) {
        diags.push({
          severity: "warning",
          rule: "restart-value",
          message: `\`${name}.restart\` = \`${r}\` is not a valid policy (no, always, on-failure, unless-stopped).`,
          line: lineOfServiceField(lines, svcLine, "restart"),
        });
      }
    }

    // --- Platform-specific (how Deplo will transform this) ---

    // container_name is stripped - let the user know it won't take effect.
    if ("container_name" in svc) {
      diags.push({
        severity: "info",
        rule: "container-name-stripped",
        message: `Deplo strips \`container_name\` (it would collide between services); \`${name}\` will use Compose's generated name.`,
        line: lineOfServiceField(lines, svcLine, "container_name"),
      });
    }

    // ANY network_mode takes the service out of its own network, so `wireApp`
    // refuses to wire it and the router is skipped: a domain pointed at it answers
    // 404 with nothing said. `host` is only the form people expect to be told about
    // - the VPN sidecar (`service:`/`container:`) is just as unroutable and is the
    // commoner shape by far.
    if (typeof svc.network_mode === "string" && svc.network_mode.trim()) {
      const mode = svc.network_mode.trim();
      diags.push({
        severity: "warning",
        rule: "network-mode-host",
        message:
          `\`${name}\` uses \`network_mode: ${mode}\`, which keeps it off its ` +
          `environment's network and out of Traefik's reach. A domain pointed at ` +
          `it won't work - route a service that has its own network instead.`,
        line: lineOfServiceField(lines, svcLine, "network_mode"),
      });
    }

    // Compose forbids combining network_mode with networks, and Deplo needs
    // `networks` to attach the stack's own network.
    if ("network_mode" in svc && "networks" in svc && svc.networks != null) {
      diags.push({
        severity: "warning",
        rule: "network-mode-conflict",
        message: `\`${name}\` sets both \`network_mode\` and \`networks\` - Compose forbids combining them, and Deplo needs \`networks\` to attach the stack's own network.`,
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
  // a host bind, so the message names the same permission, and it is a warning
  // rather than an error because it IS a legitimate operator action, just not a
  // team-level one.
  const topLevelVolumes =
    doc.volumes &&
    typeof doc.volumes === "object" &&
    !Array.isArray(doc.volumes)
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

  // Top-level `secrets:`/`configs:` sourced from a file on the SERVER read it
  // into the container - same host-file access as a service `env_file`, gated on
  // the same permission. A relative name is the app's own file.
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

  // Keys that merge config from another file are REFUSED server-side (the gate
  // can't inspect what they pull in), so the editor shows an error, not a warning.
  const merge = composeUsesExternalMerge(source);
  if (merge) {
    diags.push({
      severity: "error",
      rule: "external-merge",
      message: externalMergeMessage(merge),
      line: merge === "include" ? lineOfTopKey(lines, "include") : 1,
    });
  }
  // Joining a network this app doesn't own reaches another stack's private
  // services (and can claim a DNS name there) - same permission as a host bind.
  if (composeJoinsForeignNetwork(source)) {
    diags.push({
      severity: "warning",
      rule: "foreign-network",
      message:
        "A service here joins a network this app doesn't own (an existing network by name, or one bridged onto the server). That reaches other stacks' private services. This needs the host-volume permission.",
      line: lineOfTopKey(lines, "networks"),
    });
  }
  // A `build:` reaching a host path needs the same permission as a host bind.
  if (composeBuildReachesHost(source)) {
    diags.push({
      severity: "warning",
      rule: "build-host-context",
      message:
        "A `build:` here reaches a path on the server (an absolute or `..` context/dockerfile, an SSH key, or a privileged build). This needs the host-volume permission.",
      line: 1,
    });
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
    if (idx > 0) return v.slice(0, idx);
    // No ":" → a named/anonymous volume, UNLESS compose fills the whole entry in
    // from a variable: `- ${MOUNT}` is `/:/host` once the env-file is read.
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

/** The app-files `./<x>` convention is rewritten to the project's isolated
 * files directory at deploy time, NOT a host bind mount the user picked a path
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
 * True if a single compose volume entry bind-mounts a real HOST path - an
 * absolute source, OR a `..`-escaping source, that is NOT the project-isolated
 * `./...` convention. Shared by the editor lint (warning) and the server-side
 * permission gate so the two never disagree about what counts as a host mount.
 */
export function isHostBindSource(src: string | null | undefined): boolean {
  if (!src) return false;
  // Compose reads the value AFTER the env-file, so nothing here can tell where an
  // interpolated path points - and `./${X}` is rewritten into the files dir and
  // then climbs out of it. Fail closed: the grant holder can still write one.
  if (interpolates(src)) return true;
  return (
    (src.startsWith("/") || isEscapingSource(src)) &&
    !isFilesConventionSource(src)
  );
}

/** A docker-compose document, just the slice we read for host-bind / port
 * detection. */
interface ComposeDocShape {
  services?: Record<
    string,
    { volumes?: unknown; ports?: unknown } | null | undefined
  >;
}

/**
 * Whether ANY service bind-mounts a host path ({@link isHostBindSource}) - the
 * server-side gate for `canMountHostVolumes`. Tolerant of malformed input: the
 * deploy-time parse is the authoritative check.
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

/** Where a stack's own compose file binds one of its config files. */
export interface ComposeFileBinding {
  /** The path inside the app's files dir, as `./<x>` names it. */
  filePath: string;
  /** The compose service that mounts it. */
  service: string;
  /** The absolute path it lands on inside that container. */
  mountPath: string;
  readOnly: boolean;
}

/**
 * Every `./<x>` bind a stack's services declare: which file, which service, where
 * it lands, read-only or not. The compose is the ONLY thing that knows where a
 * config file is mounted, which is what lets Storage show it as a File entry.
 */
export function composeFileBindings(composeYaml: string): ComposeFileBinding[] {
  let doc: ComposeDocShape | null;
  try {
    doc = yaml.load(composeYaml) as ComposeDocShape | null;
  } catch {
    return [];
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return [];
  const out: ComposeFileBinding[] = [];
  for (const [service, svc] of Object.entries(services)) {
    const vols = svc?.volumes;
    if (!Array.isArray(vols)) continue;
    for (const v of vols) {
      const src = volumeSource(v);
      if (!src || !isFilesConventionSource(src)) continue;
      // The whole files dir bound as one (`.` / `./`) is not a FILE - there is
      // no single path to show, and Storage has no row shape for it.
      const filePath = src.replace(/^\.\/?/, "").replace(/\/+$/, "");
      if (!filePath) continue;
      const { mountPath, readOnly } = volumeTarget(v);
      if (!mountPath) continue;
      out.push({ filePath, service, mountPath, readOnly });
    }
  }
  return out;
}

/** Target side of a volume entry: the container path and whether it is read-only. */
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

/**
 * The DNS names Deplo's own infrastructure answers to on a shared network: a
 * container registers its SERVICE NAME there and Docker round-robins a claimed
 * one, so `deplo` collects the panel's admin cookies and `postgres` its password.
 */
export const RESERVED_SHARED_NETWORK_NAMES = new Set([
  "deplo",
  "postgres",
  "traefik",
  "deplo-traefik",
  // Traefik reads its whole routing config from the socket proxy BY NAME
  // (`--providers.docker.endpoint=tcp://…:2375`), and it straddles the shared
  // network, where the shared leg wins the lookup. Both spellings ever installed.
  "deplo-socket-proxy",
  "docker-socket-proxy",
]);

/**
 * Whether a name is one the platform answers to. Compared LOWERCASE: Docker's
 * embedded DNS is case-insensitive, so a service called `Postgres` answers a
 * `postgres` query exactly like the real one.
 */
export function isReservedSharedName(name: string): boolean {
  return RESERVED_SHARED_NETWORK_NAMES.has(name.trim().toLowerCase());
}

/**
 * Every name a service answers to on a network: its own, plus `hostname:`, which
 * Docker registers in the embedded DNS just like the service name does.
 */
export function serviceClaimedNames(name: string, svc: unknown): string[] {
  const out = [name];
  const host =
    svc && typeof svc === "object" && !Array.isArray(svc)
      ? (svc as Record<string, unknown>).hostname
      : null;
  if (typeof host === "string" && host.trim() !== "") out.push(host.trim());
  return out;
}

/**
 * Every name any service in this compose would answer to on a network, lowercased
 * and deduped. What a collision check compares against - Docker's DNS is
 * case-insensitive and registers `hostname:` alongside the service name.
 */
export function composeClaimedNames(composeYaml: string): string[] {
  let doc: { services?: Record<string, unknown> } | null;
  try {
    doc = yaml.load(composeYaml) as {
      services?: Record<string, unknown>;
    } | null;
  } catch {
    return [];
  }
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return [];
  const out = new Set<string>();
  for (const [name, svc] of Object.entries(services))
    for (const claimed of serviceClaimedNames(name, svc))
      out.add(claimed.toLowerCase());
  return [...out];
}

/**
 * The reserved name ONE named service of this compose would claim, or null.
 * Routing a service puts it on the shared network, so the domain path asks this
 * before it stores a row the renderer would then refuse to wire.
 */
export function composeServiceReservedClaim(
  composeYaml: string | null | undefined,
  service: string,
): string | null {
  if (!composeYaml) return isReservedSharedName(service) ? service : null;
  let doc: { services?: Record<string, unknown> } | null;
  try {
    doc = yaml.load(composeYaml) as {
      services?: Record<string, unknown>;
    } | null;
  } catch {
    return null;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return isReservedSharedName(service) ? service : null;
  return serviceReservedClaim(service, services[service]);
}

/** The first reserved name this service would claim, or null. */
export function serviceReservedClaim(
  name: string,
  svc: unknown,
): string | null {
  return serviceClaimedNames(name, svc).find(isReservedSharedName) ?? null;
}

/**
 * The name a top-level network entry resolves to ON THE HOST, or null when
 * compose would create it under this project's own prefix.
 */
function resolvedNetworkName(key: string, raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.name === "string" && n.name.trim() !== "") return n.name.trim();
  const ext = n.external;
  if (ext && typeof ext === "object" && !Array.isArray(ext)) {
    const name = (ext as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim() !== "") return name.trim();
    return key;
  }
  // `external: true` attaches the network the KEY names, verbatim - and compose
  // reads `yes`/`on`/`"true"` as true just the same.
  return composeTruthy(ext) ? key : null;
}

/**
 * A network Deplo owns: the platform's own, or one it mints for a tenant. The
 * platform's names are matched with an optional compose PROJECT PREFIX - Traefik
 * comes up from `$AGENT_DATA/traefik`, so its network is `traefik_deplo-socket`.
 */
export function isDeploNetwork(name: string): boolean {
  const n = name.trim();
  if (isTenantNetwork(n)) return true;
  if ((PLATFORM_NETWORKS as readonly string[]).includes(n)) return true;
  // Only the two the Traefik stack DECLARES take a compose project prefix on a
  // host. `deplo` itself is `external:` there, so it never gets one - and matching
  // `_deplo` would read somebody's own `myapp_deplo` as the platform's.
  if (n.endsWith("_deplo-socket") || n.endsWith("_deplo-internal")) return true;
  // The private `default` compose creates for another Deplo stack: `deplo-<slug>`
  // is the project name this platform sets, so `deplo-shop_default` is a tenant's
  // own network under a name anybody can guess from the app's slug.
  return /^deplo-[a-z0-9][a-z0-9_.-]*_default$/i.test(n);
}

/**
 * Every top-level network KEY resolving to a network DEPLO owns. Resolved by
 * NAME, not by key: `{default: {external: true, name: deplo-env-…}}` put a whole
 * stack on another Environment's network. `buildComposeStack` collapses them.
 */
export function sharedNetworkKeys(doc: { networks?: unknown }): Set<string> {
  // Seeded with `deplo` ALONE, the key the renderer itself writes. The other
  // platform names are not keys anybody else may claim: `networks: {deplo-internal:
  // {internal: true}}` is an author's own private network - compose creates it as
  // `<project>_deplo-internal` - and swallowing it put a deliberately internal
  // network on the whole Environment, internet egress included.
  const keys = new Set<string>([INFRA_NETWORK]);
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return keys;
  for (const [key, raw] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    const target = resolvedNetworkName(key, raw);
    if (target && isDeploNetwork(target)) keys.add(key);
  }
  return keys;
}

/**
 * True when a service's `networks:` (either shape) joins one of those keys. A
 * service that declares NONE joins `default`, which is a key like any other -
 * leaving that out is what let a compose point `default` at another
 * Environment's network and pass every check here.
 */
function joinsSharedNetwork(
  svc: Record<string, unknown>,
  shared: Set<string>,
): boolean {
  if (shared.size === 0) return false;
  const n = svc.networks;
  const keys = Array.isArray(n)
    ? n.map(String)
    : n && typeof n === "object"
      ? Object.keys(n as object)
      : null;
  // A LIST entry is a value, so compose fills `- ${NET}` in from the env-file and
  // it can name any key declared here - including one nothing else may join.
  if (keys) return keys.some((k) => shared.has(k) || interpolates(k));
  return shared.has("default");
}

/**
 * The first service claiming a reserved infrastructure name on the shared
 * network, or null. Only an EXPLICIT join is visible here; a service the router
 * puts there is caught by the same list in `buildComposeStack`.
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
  if (!services || typeof services !== "object" || Array.isArray(services))
    return null;
  const shared = sharedNetworkKeys(doc ?? {});
  for (const [name, raw] of Object.entries(services)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (!joinsSharedNetwork(raw as Record<string, unknown>, shared)) continue;
    const claim = serviceReservedClaim(name, raw);
    if (claim) return claim;
  }
  return null;
}

/** The message both checks use, so the editor and the deploy say the same thing. */
export function reservedNameMessage(claimed: string): string {
  return (
    `\`${claimed}\` is a name Deplo's own infrastructure answers to, and the proxy ` +
    `resolves it from inside your network - two containers claiming one name split ` +
    `the traffic between them. Rename the service, or its \`hostname:\` if that is ` +
    `what this names.`
  );
}

/**
 * The first service whose `hostname:` compose fills in from a variable, or null.
 * That value decides which name the container answers to - `deplo` included - and
 * arrives from the env-file, so no reading of the authored text can see it.
 */
export function composeInterpolatedHostname(
  composeYaml: string,
): string | null {
  const services = servicesOf(composeYaml);
  if (!services) return null;
  for (const [name, svc] of Object.entries(services)) {
    const host = (svc as Record<string, unknown> | null)?.hostname;
    if (isInterpolated(host)) return name;
  }
  return null;
}

/** The message both of those checks use. */
export function interpolatedHostnameMessage(service: string): string {
  return (
    `\`hostname\` on service \`${service}\` is filled in from a variable, so Deplo ` +
    `cannot tell which name that container answers to on its network. Write the ` +
    `value in the compose file.`
  );
}

/**
 * Whether a TOP-LEVEL `volumes:` entry points at storage Deplo did not create for
 * this app: `external:`/a pinned `name:` attaches an existing volume by its
 * deterministic host name, `driver_opts: {device: /}` is a bind one level up.
 * Read on the AUTHORED compose - the renderer adds its own entries later.
 */
function foreignVolumeKeys(volumes: Record<string, unknown>): string[] {
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

/**
 * Top-level `secrets:`/`configs:` keys sourced from a file on the SERVER - the
 * same host-file read an `env_file` is, one level up, so the same grant. A
 * relative name is the app's own file; an `environment:` secret carries no path.
 */
function fileSourcedKeys(entries: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.file === "string" && isHostBindSource(v.file.trim()))
      out.push(key);
  }
  return out;
}

/**
 * The services a stack declares, in the order it declares them. Used by the
 * new-app wizard to name the app after its first service and to say how big the
 * stack is without opening the editor. Empty for anything that doesn't parse -
 * the linter is what reports that.
 */
export function composeServiceNames(composeYaml: string): string[] {
  let doc: { services?: Record<string, unknown> } | null;
  try {
    doc = yaml.load(composeYaml) as typeof doc;
  } catch {
    return [];
  }
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return [];
  return Object.keys(services as Record<string, unknown>);
}

/** The services map of a compose file, or null when there isn't one. */
function servicesOf(
  composeYaml: string | null,
): Record<string, unknown> | null {
  if (!composeYaml || !composeYaml.trim()) return null;
  let doc: { services?: Record<string, unknown> } | null;
  try {
    doc = yaml.load(composeYaml) as typeof doc;
  } catch {
    return null;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return null;
  return services;
}

/** First entry of a `ports:`/`expose:` list as a container port (`"8080:80"` -> 80). */
function portFromList(raw: unknown): number | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  let n = NaN;
  if (typeof first === "number") n = first;
  else if (typeof first === "string") {
    const parts = first.split(":");
    const target = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    n = Number(target.replace(/\/.*$/, "").trim());
  } else if (first && typeof first === "object")
    n = Number((first as Record<string, unknown>).target);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The container port a service answers on: the port it publishes, else the one it
 * only `expose:`s - which is all a template has left, since the catalog strips
 * `ports:` from every blueprint.
 */
export function declaredPort(svc: unknown): number | null {
  const s = (svc ?? {}) as { ports?: unknown; expose?: unknown };
  return portFromList(s.ports) ?? portFromList(s.expose);
}

/** A port a healthcheck dials (`curl -f http://localhost:3000/`, `wget ...:8080`).
 *  The last thing a service says about the port it answers on when it publishes
 *  none - and one-click templates say it far more often than they `expose:`. */
function healthCheckPort(svc: unknown): number | null {
  const test = (svc as { healthcheck?: { test?: unknown } })?.healthcheck?.test;
  const text = Array.isArray(test)
    ? test.map(String).join(" ")
    : typeof test === "string"
      ? test
      : "";
  const n = Number(/:(\d{2,5})(?=[/\s"']|$)/.exec(text)?.[1]);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * The container port a route to ONE compose service should reach: what it
 * publishes, what its healthcheck dials, else the conventional web port - the
 * renderer's own answer said out loud, so an imported domain carries a real port.
 */
export function composeRoutePort(
  compose: string | null | undefined,
  service: string,
): number | null {
  const services = servicesOf(compose ?? null);
  const svc = services?.[service];
  if (!svc) return null;
  return declaredPort(svc) ?? healthCheckPort(svc) ?? 80;
}

/** Every service another service names in `depends_on` (list form and map form). */
function dependedUpon(services: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const svc of Object.values(services)) {
    const dep = (svc as { depends_on?: unknown })?.depends_on;
    if (Array.isArray(dep)) {
      for (const d of dep) if (typeof d === "string") out.add(d);
    } else if (dep && typeof dep === "object") {
      for (const k of Object.keys(dep)) out.add(k);
    }
  }
  return out;
}

function imageOf(svc: unknown): string | null {
  const img = (svc as { image?: unknown })?.image;
  return typeof img === "string" ? img : null;
}

/**
 * The services a domain may point at: not a name the platform answers to on the
 * shared network, and not a database. A stack of nothing BUT databases keeps the
 * whole list - it is the one case where routing at a datastore is the only answer
 * there is.
 */
function routableNames(services: Record<string, unknown>): string[] {
  const names = Object.keys(services).filter((n) => !isReservedSharedName(n));
  const web = names.filter((n) => !isDatastoreImage(imageOf(services[n])));
  return web.length > 0 ? web : names;
}

/**
 * Pick a default `{service, port}` to seed a compose project's FIRST domain when
 * neither the template nor the user named one. Used at project creation only -
 * after that the `domains` table (each row's `service`) is authoritative.
 */
export function detectDefaultApp(
  compose: string | null,
): { service: string; port: number } | null {
  const services = servicesOf(compose);
  if (!services) return null;
  const names = routableNames(services);
  if (names.length === 0) return null;
  // A declared port is the author saying "here", so those candidates come first;
  // among equals, the front door is the service no other one waits on.
  const depended = dependedUpon(services);
  const front = (list: string[]): string =>
    list.find((n) => !depended.has(n)) ?? list[0];
  const withPort = names.filter((n) => declaredPort(services[n]));
  const service = front(withPort.length > 0 ? withPort : names);
  return { service, port: declaredPort(services[service]) ?? 80 };
}

/** One row of the wizard's "which services get a domain" list. */
export interface ComposeRouteCandidate {
  name: string;
  port: number;
  /** Runs one of the engines Deplo provisions - offered, but never pre-selected. */
  isDatastore: boolean;
  /** Deplo's own name on the shared network: it can never hold a domain. */
  isReserved: boolean;
  /** The one the auto domain is born on. */
  isPrimary: boolean;
}

/**
 * Every service of a stack with what the new-app wizard needs to offer it a
 * domain. Same reading as {@link detectDefaultApp}, so the row marked primary is
 * the one the server would have picked on its own.
 */
export function composeRouteCandidates(
  compose: string | null,
): ComposeRouteCandidate[] {
  const services = servicesOf(compose);
  if (!services) return [];
  const primary = detectDefaultApp(compose)?.service ?? null;
  return Object.keys(services).map((name) => ({
    name,
    port: declaredPort(services[name]) ?? 80,
    isDatastore: isDatastoreImage(imageOf(services[name])),
    isReserved: serviceReservedClaim(name, services[name]) != null,
    isPrimary: name === primary,
  }));
}

/**
 * The volumes DEPLO itself creates for a stack: every top-level entry that is
 * neither `external:` nor pinned to its own `name:`. Named for the teardown,
 * which a `down -v` cannot reach on a stack that was never deployed.
 */
export function composeOwnVolumeKeys(composeYaml: string): string[] {
  let doc: { volumes?: Record<string, unknown> } | null;
  try {
    doc = yaml.load(composeYaml) as typeof doc;
  } catch {
    return [];
  }
  const declared = doc?.volumes;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return [];
  return Object.entries(declared as Record<string, unknown>)
    .filter(([, v]) => {
      if (v == null) return true; // `vol:` with no body - compose creates it
      if (typeof v !== "object") return false;
      const spec = v as { external?: unknown; name?: unknown };
      return !spec.external && typeof spec.name !== "string";
    })
    .map(([k]) => k);
}

/**
 * Whether a compose points at storage or host FILES this app does not own -
 * {@link foreignVolumeKeys} or {@link fileSourcedKeys}. Gated server-side behind
 * `canMountHostVolumes`. Tolerant of malformed input, like the others.
 */
export function composeMountsForeignStorage(composeYaml: string): boolean {
  let doc: {
    volumes?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
    configs?: Record<string, unknown>;
  } | null;
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
 * Top-level network KEYS pointing at a network Deplo did not create for this app -
 * the twin of {@link foreignVolumeKeys}. Project names are deterministic
 * (`deplo-<slug>_default`), and joining one exposes every unpublished service AND
 * lets a `postgres` service collect the victim's lookups by DNS round-robin.
 */
function foreignNetworkKeys(networks: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(networks)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    // A network Deplo owns is governed by its own choke point, not by this gate:
    // `buildComposeStack` collapses every key naming one onto this stack's own
    // network, so joining it reaches nothing.
    const target = resolvedNetworkName(key, raw);
    if (target !== null && isDeploNetwork(target)) continue;
    const pinnedName =
      typeof n.name === "string" && n.name.trim() !== "" ? n.name.trim() : null;
    const pinned =
      (n.external != null && n.external !== false) ||
      pinnedName !== null ||
      (n.driver_opts != null &&
        typeof n.driver_opts === "object" &&
        Object.keys(n.driver_opts as object).length > 0) ||
      // A driver that bridges onto the host's own segment rather than a private
      // docker bridge reaches past the app either way.
      (typeof n.driver === "string" &&
        /^(macvlan|ipvlan|host)$/i.test(n.driver.trim()));
    if (pinned) out.push(key);
  }
  return out;
}

/**
 * Whether ANY service joins a network this app does not own ({@link
 * foreignNetworkKeys}). Same `canMountHostVolumes` grant as its storage sibling:
 * both reach past the container's boundary. Only an ACTUAL join counts.
 */
export function composeJoinsForeignNetwork(composeYaml: string): boolean {
  let doc: { services?: Record<string, unknown>; networks?: unknown } | null;
  try {
    doc = yaml.load(composeYaml) as {
      services?: Record<string, unknown>;
      networks?: unknown;
    } | null;
  } catch {
    return false;
  }
  const declared =
    doc?.networks &&
    typeof doc.networks === "object" &&
    !Array.isArray(doc.networks)
      ? (doc.networks as Record<string, unknown>)
      : {};
  const foreign = new Set(foreignNetworkKeys(declared));
  if (foreign.size === 0) return false;
  const services = doc?.services;
  if (!services || typeof services !== "object") return false;
  for (const raw of Object.values(services)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    // Same join-shape reader the shared-network rule uses (list OR map form).
    if (joinsSharedNetwork(raw as Record<string, unknown>, foreign))
      return true;
  }
  return false;
}

/**
 * Whether any service's `build:` reaches a host path the app does not own - an
 * absolute or `..`-escaping context/dockerfile, an `additional_contexts` source,
 * an `ssh:` key, or a privileged build. Same host reach as a bind, same grant.
 */
export function composeBuildReachesHost(composeYaml: string): boolean {
  let doc: { services?: Record<string, unknown> } | null;
  try {
    doc = yaml.load(composeYaml) as {
      services?: Record<string, unknown>;
    } | null;
  } catch {
    return false;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return false;
  for (const raw of Object.values(services)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const b = (raw as Record<string, unknown>).build;
    if (b == null) continue;
    if (typeof b === "string") {
      if (isHostBindSource(b)) return true; // `build: /abs` (context shorthand)
      continue;
    }
    if (typeof b !== "object" || Array.isArray(b)) continue;
    const rec = b as Record<string, unknown>;
    if (typeof rec.context === "string" && isHostBindSource(rec.context))
      return true;
    if (typeof rec.dockerfile === "string" && isHostBindSource(rec.dockerfile))
      return true;
    const ac = rec.additional_contexts;
    const acSources = Array.isArray(ac)
      ? ac.map((e) =>
          typeof e === "string" ? e.slice(e.indexOf("=") + 1) : "",
        )
      : ac && typeof ac === "object"
        ? Object.values(ac as Record<string, unknown>).map((v) => String(v))
        : [];
    if (acSources.some((s) => isHostBindSource(s))) return true;
    if (rec.ssh != null && (Array.isArray(rec.ssh) ? rec.ssh.length > 0 : true))
      return true;
    if (composeTruthy(rec.privileged) || isInterpolated(rec.privileged))
      return true;
  }
  return false;
}

/**
 * The first compose key that MERGES config from a file the save-time detectors
 * cannot see (`extends: {file:}`, top-level `include:`, `label_file:`), or null.
 * Compose resolves them on the host, so what they pull in never appears in the
 * authored YAML a gate parses. Refused rather than denylisted key by key.
 */
export function composeUsesExternalMerge(composeYaml: string): string | null {
  let doc: { services?: Record<string, unknown>; include?: unknown } | null;
  try {
    doc = yaml.load(composeYaml) as {
      services?: Record<string, unknown>;
      include?: unknown;
    } | null;
  } catch {
    return null;
  }
  const inc = doc?.include;
  if (inc != null && (Array.isArray(inc) ? inc.length > 0 : true))
    return "include";
  const services = doc?.services;
  if (!services || typeof services !== "object") return null;
  for (const raw of Object.values(services)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const svc = raw as Record<string, unknown>;
    const ex = svc.extends;
    if (
      ex &&
      typeof ex === "object" &&
      !Array.isArray(ex) &&
      typeof (ex as Record<string, unknown>).file === "string" &&
      String((ex as Record<string, unknown>).file).trim() !== ""
    )
      return "extends";
    const lf = svc.label_file;
    if (
      lf != null &&
      (Array.isArray(lf) ? lf.length > 0 : String(lf).trim() !== "")
    )
      return "label_file";
  }
  return null;
}

/** The message the editor and the save both use for an external-merge key. */
export function externalMergeMessage(key: string): string {
  return (
    `\`${key}\` merges configuration from another file, which Deplo can't inspect ` +
    `before it deploys - it could pull in host access or another team's hostname ` +
    `past the checks here. Inline what you need into this compose file instead.`
  );
}

/**
 * Compose keys that hand a container the host, and how to tell they are ON.
 * Every one is another way to where a `/var/run/docker.sock` bind goes -
 * `privileged` alone mounts the host disk, `pid: host` puts `nsenter -t 1` one
 * command away - so they take the same grant ({@link composeNeedsHostPrivileges}).
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
  "oom_kill_disable",
  "oom_score_adj",
  "group_add",
  "logging",
  "userns_mode",
  "post_start",
  "pre_stop",
  "deploy",
  // `gpus` is the shorthand for the device reservation gated above; `runtime`
  // swaps the OCI runtime (nvidia hands over the GPUs, sysbox/kata change the
  // sandbox); `host-gateway` in `extra_hosts` names the host itself.
  "gpus",
  "runtime",
  "extra_hosts",
] as const;

/**
 * The `network_mode:` values that reach nothing: no network at all, and this
 * compose project's own default. Everything else - `host`, `container:`,
 * `service:`, a bare network name, an `${INTERPOLATION}` - is gated.
 */
const SAFE_NETWORK_MODE = /^(none|default)$/i;

/**
 * `security_opt` entries that only ever make a container SAFER, so are not gated:
 * asking for the host permission in order to HARDEN one teaches people to skip it.
 * The VALUE is read - `no-new-privileges:false` is the option turned off.
 */
const SAFE_SECURITY_OPTS = /^no-new-privileges(?:[:=]\s*true)?$/i;

/**
 * The keys of {@link HOST_PRIVILEGE_KEYS} this service actually sets, in
 * declaration order. A key present but empty declares nothing. The namespace
 * selectors flag `host` and `container:`/`service:` - both escape - not a real value.
 */
function hostPrivilegeKeys(svc: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of HOST_PRIVILEGE_KEYS) {
    const v = svc[key];
    if (v == null) continue;
    if (key === "privileged" || key === "oom_kill_disable") {
      // `oom_kill_disable: true` means the kernel kills OTHER tenants' containers
      // under memory pressure instead of this one - a cross-tenant availability
      // hit, so it takes the same grant.
      if (composeTruthy(v) || isInterpolated(v)) out.push(key);
      continue;
    }
    if (key === "oom_score_adj") {
      // A NEGATIVE adjust is `oom_kill_disable` by degrees: it makes the kernel
      // spare this container and kill its neighbours (other tenants, and the
      // platform's own containers) when the host runs out of memory. A positive
      // value only volunteers this container first, which is safe and free.
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if ((Number.isFinite(n) && n < 0) || isInterpolated(v)) out.push(key);
      continue;
    }
    if (key === "group_add") {
      // Supplementary HOST groups (`docker`, `disk`) inside the container.
      if (Array.isArray(v) ? v.length > 0 : String(v).trim() !== "")
        out.push(key);
      continue;
    }
    if (key === "logging") {
      // A non-default logging driver makes DOCKERD itself dial an address (or a
      // host socket/path) the author chose, from outside the container's sandbox.
      // `json-file`/`local` with no options is what Deplo's own logs read from.
      if (typeof v !== "object" || Array.isArray(v)) continue;
      const log = v as Record<string, unknown>;
      const driver =
        typeof log.driver === "string" ? log.driver.trim().toLowerCase() : "";
      const opts =
        log.options &&
        typeof log.options === "object" &&
        !Array.isArray(log.options)
          ? (log.options as Record<string, unknown>)
          : {};
      const nonDefaultDriver =
        driver !== "" && driver !== "json-file" && driver !== "local";
      // json-file's own size knobs are harmless; anything else is a driver option.
      const risky = Object.keys(opts).some(
        (k) => !/^max-(size|file)$/i.test(k.trim()),
      );
      if (nonDefaultDriver || risky) out.push(key);
      continue;
    }
    if (key === "network_mode") {
      // An ALLOWLIST, because this one takes a free-form string and ANY value that
      // is not a keyword is a docker NETWORK NAME - `network_mode: deplo-env-<id>`
      // attaches the container to another Environment's network, with DNS, and no
      // `networks:` key for the rest of this file to see. A denylist of the three
      // keywords let every network on the host through.
      if (typeof v === "string" && !SAFE_NETWORK_MODE.test(v.trim()))
        out.push(key);
      continue;
    }
    if (key === "pid" || key === "ipc" || key === "uts" || key === "cgroup") {
      if (typeof v === "string") {
        const val = v.trim().toLowerCase();
        // `host` shares the host namespace; `container:`/`service:` joins ANOTHER
        // container's namespace on the same daemon (not limited to this stack). An
        // interpolated value is any of them once the env-file is read.
        if (
          val === "host" ||
          val.startsWith("container:") ||
          val.startsWith("service:") ||
          interpolates(val)
        )
          out.push(key);
      }
      continue;
    }
    if (key === "volumes_from") {
      // Mounts another container's volumes. `container:<name>` names a container
      // OUTSIDE this stack (another tenant's, or the platform's) - the escape;
      // a bare service name is same-stack and left alone.
      const list = Array.isArray(v) ? v : [v];
      if (
        list.some(
          (e) =>
            typeof e === "string" &&
            (e.trim().toLowerCase().startsWith("container:") ||
              interpolates(e)),
        )
      )
        out.push(key);
      continue;
    }
    if (key === "env_file") {
      // The same rule its bind-mount twin gets: an absolute or `..` path reads a
      // file on the SERVER, a relative name reads one inside the stack's own
      // project directory, which is the app's own. `env_file: - .env` is the
      // commonest env pattern there is, and gating it gated the whole feature.
      const list = Array.isArray(v) ? v : [v];
      const names = list.map((e) =>
        e && typeof e === "object"
          ? String((e as Record<string, unknown>).path ?? "")
          : String(e),
      );
      if (names.some((n) => isHostBindSource(n.trim()))) out.push(key);
      continue;
    }
    if (key === "post_start" || key === "pre_stop") {
      const hooks = (Array.isArray(v) ? v : [v]).filter(
        (h): h is Record<string, unknown> =>
          Boolean(h) && typeof h === "object",
      );
      if (
        hooks.some(
          (h) => composeTruthy(h.privileged) || isInterpolated(h.privileged),
        )
      )
        out.push(key);
      continue;
    }
    if (key === "deploy") {
      // Only the device reservations: `deploy.resources.limits` is the ordinary
      // way to cap a service and must stay free. Named in full, because a refusal
      // saying `deploy` sends the reader looking at the wrong key.
      const asMap = (x: unknown): Record<string, unknown> =>
        x && typeof x === "object" && !Array.isArray(x)
          ? (x as Record<string, unknown>)
          : {};
      const devices = asMap(asMap(asMap(v).resources).reservations).devices;
      if (Array.isArray(devices) && devices.length > 0)
        out.push("deploy.resources.reservations.devices");
      continue;
    }
    if (key === "security_opt") {
      const weakening = Array.isArray(v)
        ? v.filter((o) => !SAFE_SECURITY_OPTS.test(String(o).trim()))
        : [v];
      if (weakening.length > 0) out.push(key);
      continue;
    }
    if (key === "runtime") {
      // `runc` is docker's own default and selects nothing.
      if (typeof v !== "string" || v.trim().toLowerCase() !== "runc")
        out.push(key);
      continue;
    }
    if (key === "extra_hosts") {
      const entries = Array.isArray(v)
        ? v.map(String)
        : v && typeof v === "object"
          ? Object.values(v as Record<string, unknown>).map(String)
          : [String(v)];
      if (entries.some((e) => /host-gateway/i.test(e) || interpolates(e)))
        out.push(key);
      continue;
    }
    if (
      Array.isArray(v)
        ? v.length > 0
        : typeof v === "object" || String(v).trim() !== ""
    )
      out.push(key);
  }
  return out;
}

/**
 * Whether ANY service asks for host privileges ({@link HOST_PRIVILEGE_KEYS}),
 * gated behind `canMountHostVolumes` like its two siblings. Tolerant of malformed
 * input: the deploy-time parse is the authoritative one.
 */
export function composeNeedsHostPrivileges(composeYaml: string): boolean {
  return composeHostPrivilegeKeys(composeYaml).length > 0;
}

/**
 * The privilege keys this whole file sets, deduped and in declaration order, so a
 * refusal can name what tripped it instead of guessing at a bind mount.
 */
export function composeHostPrivilegeKeys(composeYaml: string): string[] {
  let doc: { services?: Record<string, unknown> } | null;
  try {
    doc = yaml.load(composeYaml) as {
      services?: Record<string, unknown>;
    } | null;
  } catch {
    return [];
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return [];
  const out = new Set<string>();
  for (const svc of Object.values(services)) {
    if (!svc || typeof svc !== "object" || Array.isArray(svc)) continue;
    for (const key of hostPrivilegeKeys(svc as Record<string, unknown>))
      out.add(key);
  }
  return [...out];
}

/**
 * What in this compose reaches PAST the container, in words. One list, so the
 * gate, the import preview and the refusal can never name it differently - the
 * refusal used to say "a Bind" whatever had actually tripped it.
 */
export function composeHostReach(composeYaml: string): string[] {
  const out: string[] = [];
  if (composeHasHostBindMount(composeYaml))
    out.push("a bind mount of a folder on the server");
  const keys = composeHostPrivilegeKeys(composeYaml);
  if (keys.length > 0) out.push(keys.map((k) => `\`${k}\``).join(", "));
  if (composeMountsForeignStorage(composeYaml))
    out.push("a volume it did not declare");
  if (composeBuildReachesHost(composeYaml))
    out.push("a build that reads a path on the server");
  if (composeJoinsForeignNetwork(composeYaml))
    out.push("a network outside this app");
  return out;
}

/**
 * Whether ANY service publishes a port on the HOST - the `canExposePorts` gate.
 * `expose:` is NOT publishing and is deliberately not counted: it binds nothing,
 * and gating it charged the grant for two thirds of a measured fleet. Traefik
 * routing is independent, and an empty `ports:` declares nothing.
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
  }
  return false;
}

/**
 * The HOST ports a compose file would bind, deduped - WHICH, where
 * `composePublishesPorts` answers whether. For the import, which has to say a
 * `80:80` will not land before anything is created. Ranges expanded, bounded.
 */
export function composeHostPorts(composeYaml: string): number[] {
  let doc: ComposeDocShape | null;
  try {
    doc = yaml.load(composeYaml) as ComposeDocShape | null;
  } catch {
    return [];
  }
  const out = new Set<number>();
  const add = (n: unknown) => {
    const port = typeof n === "number" ? n : Number(String(n ?? "").trim());
    if (Number.isInteger(port) && port > 0 && port < 65536) out.add(port);
  };
  for (const svc of Object.values(doc?.services ?? {})) {
    const ports = svc?.ports;
    if (!Array.isArray(ports)) continue;
    for (const entry of ports) {
      if (entry && typeof entry === "object") {
        add((entry as { published?: unknown }).published);
        continue;
      }
      if (typeof entry === "number") continue; // `- 3000` is a container port
      if (typeof entry !== "string") continue;
      // `[ip:]host[-range]:container[/proto]` - the host side is the
      // second-to-last colon-separated field when there are two or more.
      const parts = entry.split("/")[0].split(":");
      if (parts.length < 2) continue;
      const host = parts[parts.length - 2];
      const range = /^(\d+)-(\d+)$/.exec(host);
      if (range) {
        const from = Number(range[1]);
        const to = Math.min(Number(range[2]), from + 24);
        for (let p = from; p <= to; p++) add(p);
        continue;
      }
      add(host);
    }
  }
  return [...out];
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
    // `- "${PORT}:80"` is a host binding the moment the env-file is read, and the
    // shape below cannot match it. Counted, so the grant is asked for.
    if (interpolates(p)) return true;
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
  return [...diags].sort(
    (a, b) =>
      a.line - b.line || severityRank(a.severity) - severityRank(b.severity),
  );
}
function severityRank(s: LintSeverity): number {
  return s === "error" ? 0 : s === "warning" ? 1 : 2;
}

/** The most compose text an app may carry, and the most nodes it may expand to. */
export const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_COMPOSE_NODES = 20_000;

/**
 * Refuse a compose file that is too big to keep, or that expands past reason: a
 * few nested YAML aliases turn 400 bytes into gigabytes when the renderer dumps
 * the document with every alias resolved, and that dump runs on the event loop.
 */
const tooManyEntries = () =>
  new Error(
    "The compose file expands to too many entries - unroll its YAML anchors.",
  );

export function assertComposeWithinLimits(composeYaml: string): void {
  if (Buffer.byteLength(composeYaml, "utf8") > MAX_COMPOSE_BYTES)
    throw new Error("The compose file is too large (256 KiB max).");
  let doc: unknown;
  try {
    doc = yaml.load(composeYaml);
  } catch (e) {
    if (/alias count/i.test(String(e))) throw tooManyEntries();
    return; // unparseable never expands; the linter says why it is wrong
  }
  let nodes = 0;
  const walk = (v: unknown): void => {
    if (++nodes > MAX_COMPOSE_NODES) throw tooManyEntries();
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object")
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  walk(doc);
}

/**
 * Whether any service carries an `environment:` VALUE inline - `KEY=value` in the
 * list form, or a non-empty value in the map form. A bare `KEY` (a pass-through
 * the deploy fills from the env-file) is not a value.
 */
export function composeHasInlineEnvValues(composeYaml: string): boolean {
  let doc: ComposeDocShape | null;
  try {
    doc = yaml.load(composeYaml) as ComposeDocShape | null;
  } catch {
    return false;
  }
  for (const svc of Object.values(doc?.services ?? {})) {
    const env = (svc as { environment?: unknown } | null)?.environment;
    if (Array.isArray(env)) {
      if (env.some((e) => typeof e === "string" && e.includes("=")))
        return true;
    } else if (env && typeof env === "object") {
      if (
        Object.values(env as Record<string, unknown>).some(
          (v) => v != null && String(v) !== "",
        )
      )
        return true;
    }
  }
  return false;
}
