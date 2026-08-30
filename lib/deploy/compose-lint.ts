/**
 * Client-safe docker-compose linter for the Compose editor.
 *
 * Deplo post-processes every compose file before it deploys it (see
 * `compose-stack.ts`): it joins the exposed service to the external `deplo`
 * network, adds Traefik routing labels (leaving published `ports:` intact), and
 * strips `container_name`. The linter's job is to catch the
 * mistakes that break that pipeline, and the everyday compose mistakes users
 * make - BEFORE they hit save, with a line number for each.
 *
 * It runs in the browser (no `server-only`, only `js-yaml`, which is already a
 * dependency). The server still validates authoritatively at deploy time; this
 * is fast feedback, not a security boundary.
 */

import yaml, { isMap, isScalar, Scalar, visit, type Document } from "../yaml";

import { isDatastoreImage } from "../databases/images";
import { PLATFORM_NETWORKS } from "./network";

/**
 * An `environment:` value is TEXT by the time the container reads it, so the text
 * the author typed IS the value. `UMASK: 022` parses to the number 22 and would
 * come back out as `22`; quoting it is what keeps it `022`. Same for `1.10`, which
 * re-serializes to `1.1`. Only `environment`, because everywhere else a number is
 * a number and quoting it would change what compose reads.
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
        if (isFilesConventionSource(src)) {
          diags.push({
            severity: "info",
            rule: "bind-mount-files-note",
            message: `\`${name}\` mounts \`${src}\` - Deplo rewrites this to your project's isolated files directory at deploy time.`,
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
            message: `\`${name}\` bind-mounts host path \`${src}\` - it must exist on the deploy host and isn't isolated per project. Prefer a Volume (storage deplo creates and keeps).`,
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
        message: `\`${name}\` sets both \`network_mode\` and \`networks\` - Compose forbids combining them, and Deplo needs \`networks\` to attach the \`deplo\` network.`,
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
    return idx > 0 ? v.slice(0, idx) : null; // no ":" → a named/anonymous volume
  }
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (rec.type === "bind" && typeof rec.source === "string")
      return rec.source;
    if (typeof rec.source === "string" && rec.source.includes("/"))
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
    { volumes?: unknown; ports?: unknown } | null | undefined
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
 * Every `./<x>` bind a stack's services declare: which file, which service,
 * where it lands, read-only or not.
 *
 * The compose is the ONLY thing that knows where a stack's config file is
 * mounted - the file itself just sits in the app's files dir - so this is what
 * lets Storage show a config file as a **File** entry with a real container path
 * instead of a name with nowhere attached to it. An import reads it to describe
 * a file mount the way the platform it came from described it.
 *
 * Tolerant like its neighbours: an unparseable document simply declares nothing.
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
function volumeTarget(v: unknown): { mountPath: string; readOnly: boolean } {
  if (typeof v === "string") {
    const [, target = "", mode = ""] = v.split(":");
    return { mountPath: target.trim(), readOnly: mode.trim() === "ro" };
  }
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    return {
      mountPath: typeof rec.target === "string" ? rec.target.trim() : "",
      readOnly: rec.read_only === true,
    };
  }
  return { mountPath: "", readOnly: false };
}

/**
 * The DNS names Deplo's own infrastructure answers to on the shared `deplo`
 * network. A container joining that network registers its SERVICE NAME as an
 * alias there, and Docker round-robins a name two containers both claim, so a
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
 * Every top-level network KEY in this compose that resolves to one of the
 * PLATFORM's networks, which is not only the key `deplo`.
 *
 * Compose lets a network be referenced under any key while pointing at another
 * network by `name:`, so
 *
 *     networks: { sneaky: { external: true, name: deplo } }
 *
 * is the platform's network under an alias of the author's choosing. Checking the
 * key alone is the same mistake as trusting an identifier that names itself:
 * every rule about these networks has to resolve them by NAME first, or the rule
 * is one rename away from being decorative.
 *
 * `buildComposeStack` re-points every key this returns at the stack's OWN
 * network, so an authored join lands in the app's Environment instead of next to
 * the panel. Exported so the renderer and the editor agree on which keys those are.
 */
export function sharedNetworkKeys(doc: { networks?: unknown }): Set<string> {
  const platform = new Set<string>(PLATFORM_NETWORKS);
  const keys = new Set<string>(platform);
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return keys;
  for (const [key, raw] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    const ext =
      n.external != null &&
      typeof n.external === "object" &&
      !Array.isArray(n.external)
        ? (n.external as Record<string, unknown>).name
        : undefined;
    const named =
      (typeof n.name === "string" && platform.has(n.name.trim())) ||
      (typeof ext === "string" && platform.has(ext.trim()));
    if (named) keys.add(key);
  }
  return keys;
}

/** True when a service's `networks:` (either shape) joins one of those keys. */
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
    `\`${claimed}\` can't be claimed on Deplo's shared network - it is a name the ` +
    `platform itself answers to there, and two containers claiming one name split ` +
    `the traffic between them. Rename the service (or its \`hostname:\`), or take ` +
    `it off the \`deplo\` network.`
  );
}

/**
 * Whether a TOP-LEVEL `volumes:` entry points at storage Deplo did not create
 * for this app - the other half of the host-volume permission, and the half no
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
 * Top-level `secrets:`/`configs:` keys sourced from a file on the SERVER
 * (`file: /etc/…`, or one climbing out with `..`). Docker mounts it into the
 * container, so it is the same host-file read a service `env_file` is, one level
 * up, and it takes the same grant - by the same rule: a relative name resolves
 * inside the stack's own project directory and is the app's own file. An
 * `environment:`-sourced secret carries no path at all and is left alone.
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
 * The volumes DEPLO itself creates for a stack: every top-level `volumes:` entry
 * that is neither `external:` nor pinned to a `name:` of its own, so compose
 * creates it as `<project>_<key>` and it belongs to this app alone.
 *
 * Used by the teardown to name what a `down -v` cannot reach - a stack that was
 * never deployed has no compose file on the host, so `down` has nothing to read
 * and the volumes an import already filled would survive the app that owned
 * them. A volume the user pointed elsewhere is deliberately NOT in this list:
 * Deplo does not own those and must never remove one.
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
 * Top-level network KEYS this compose points at a network Deplo did not create
 * for this app - the network twin of {@link foreignVolumeKeys}, and the half no
 * check used to look at.
 *
 * A network is "foreign" on exactly the markers a volume is: `external: true`
 * (attach an EXISTING docker network by host name), a pinned `name:` (the same
 * thing spelled differently), or `driver_opts` / a host-reaching `driver`
 * (`macvlan`/`ipvlan` put the container on the host's own L2 segment). Compose
 * project names are deterministic (`deplo-<slug>`), so another team's default
 * network is `deplo-<their-slug>_default` - guessable from any app name.
 *
 * Joining it is worse than reading their storage:
 *
 *  - every unpublished service of that stack becomes reachable at L3 (their
 *    database, their redis, their internal HTTP), and
 *  - a container on a network registers its SERVICE NAME as a DNS alias there,
 *    and Docker round-robins a name two containers both claim, so a service
 *    called `postgres` or `redis` collects the victim's own internal lookups,
 *    password and all. The tenant-network protections (`aliases:` drop,
 *    RESERVED_SHARED_NETWORK_NAMES) only fire for the stack's own network, and
 *    `buildComposeStack` leaves every other network exactly as authored.
 *
 * A PLATFORM network is NOT foreign here: the renderer re-points every key naming
 * one at the stack's own network, so it reaches nothing. A plain per-app network
 * (`networks: {internal: {}}`) declares nothing pinned and stays free.
 */
function foreignNetworkKeys(networks: Record<string, unknown>): string[] {
  const PLATFORM = new Set<string>(PLATFORM_NETWORKS);
  const out: string[] = [];
  for (const [key, raw] of Object.entries(networks)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    // The shared network is governed by its own choke point, not by this gate.
    const pinnedName =
      typeof n.name === "string" && n.name.trim() !== "" ? n.name.trim() : null;
    const externalName =
      n.external != null &&
      typeof n.external === "object" &&
      !Array.isArray(n.external)
        ? String((n.external as Record<string, unknown>).name ?? "").trim()
        : null;
    const target =
      pinnedName ?? externalName ?? (PLATFORM.has(key) ? key : null);
    // A platform network is not foreign: `buildComposeStack` re-points every key
    // naming one at this stack's own network, so joining it reaches nothing.
    if (target !== null && PLATFORM.has(target)) continue;
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
 * Parse a compose YAML string and report whether ANY service joins a network this
 * app does not own (see {@link foreignNetworkKeys}) - another team's stack
 * network, or the host's L2 segment. Gated server-side behind
 * `canMountHostVolumes`, beside its storage sibling: both are a container
 * reaching past its own boundary, and a permission that stops one while allowing
 * the other stops nothing.
 *
 * Only a service that ACTUALLY joins one counts: declaring an external network
 * and never attaching it deploys nothing. Tolerant of malformed input, like its
 * siblings.
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
 * Parse a compose YAML string and report whether any service's `build:` reaches
 * a host path the app does not own - an absolute or `..`-escaping build
 * `context`/`dockerfile`, an `additional_contexts` source that does the same, an
 * `ssh:` key (loads host SSH keys/agents into the build), or `privileged: true`
 * (a privileged BuildKit build runs on the host). Each bakes host bytes into the
 * image the tenant then runs, or escapes at build time - the same host reach a
 * bind mount has, so the same `canMountHostVolumes` grant. A project-relative
 * `./`-context (the normal case, rewritten to the isolated files dir) stays free.
 *
 * Tolerant of malformed input, like its siblings.
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
    if (rec.privileged === true) return true;
  }
  return false;
}

/**
 * The first compose key that MERGES configuration from a file the save-time
 * detectors cannot see, or null. `docker compose` resolves these on the host, so
 * the dangerous keys they pull in (`privileged`, host binds, published ports,
 * even `traefik.*` labels via `label_file`, past {@link buildComposeStack}'s
 * label strip) never appear in the authored YAML the gate, or a deploy-time
 * re-lint of it - parses. They cannot be denylisted key-by-key, so deplo refuses
 * them: it owns the render, and an author who needs the merged config inlines it.
 *
 *  - a service `extends:` with a `file:` (a same-file `extends: {service: x}` is
 *    fine - x's own keys ARE linted);
 *  - a top-level `include:` (pulls whole other compose files);
 *  - a service `label_file:` (loads labels from a file, past the traefik strip).
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
 * the same way. It ALSO costs the container its Traefik routing - the linter's
 * separate `network-mode-host` warning still says so; both fire.
 *
 * `cgroup: host` shares the host's cgroup namespace (like `pid`/`ipc`).
 * `volumes_from: "container:<name>"` mounts ANOTHER container's volumes on the
 * same daemon - the reference is by container NAME, so it ignores the network
 * split and reaches another tenant's data (and the control-plane database volume
 * at rest); a bare service name is same-stack and left alone. `env_file` reads a
 * host file into the container's environment, and its paths resolve against the
 * SHARED stack directory on the host (`/data/stacks`), so even a relative name
 * reaches another tenant's rendered env-file - any non-empty value is gated. The
 * `file:`-sourced half of the top-level `secrets:`/`configs:` blocks is the same
 * host-file read one level up, handled in {@link composeMountsForeignStorage}.
 *
 * `oom_score_adj` is here for the same reason as `oom_kill_disable`, and only
 * when NEGATIVE: it tells the kernel to kill the neighbours first.
 * `group_add` adds supplementary HOST groups inside the container, and `logging`
 * with a non-default driver/options makes DOCKERD dial an address or host socket
 * the author chose - both reach outside the container without naming a path.
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
] as const;

/**
 * `security_opt` entries that only ever make a container SAFER, and so are not
 * gated. Everything else there (`apparmor:unconfined`, `seccomp:unconfined`,
 * `label:disable`, a hand-written seccomp profile) removes a boundary.
 *
 * `no-new-privileges` is the one people actually write, and refusing it would
 * mean asking an admin for the host permission in order to HARDEN a container -
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
 * limited to this stack) - both escape, so both are flagged. An ordinary value (a
 * bridge network name, a real hostname for uts, `cgroup: private`) is left alone.
 * `volumes_from` flags only the `container:<name>` form (a foreign container's
 * volumes); `env_file` flags only a path that leaves the stack's own directory.
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
      if (v === true) out.push(key);
      continue;
    }
    if (key === "oom_score_adj") {
      // A NEGATIVE adjust is `oom_kill_disable` by degrees: it makes the kernel
      // spare this container and kill its neighbours (other tenants, and the
      // platform's own containers) when the host runs out of memory. A positive
      // value only volunteers this container first, which is safe and free.
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (Number.isFinite(n) && n < 0) out.push(key);
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
      // `json-file`/`local` with no options is what deplo's own logs read from.
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
        if (
          val === "host" ||
          val.startsWith("container:") ||
          val.startsWith("service:")
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
            e.trim().toLowerCase().startsWith("container:"),
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
    if (key === "security_opt") {
      const weakening = Array.isArray(v)
        ? v.filter((o) => !SAFE_SECURITY_OPTS.test(String(o).trim()))
        : [v];
      if (weakening.length > 0) out.push(key);
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
 * Parse a compose YAML string and report whether ANY service asks for host
 * privileges (see {@link HOST_PRIVILEGE_KEYS}). Used server-side to gate compose
 * edits behind `canMountHostVolumes`, exactly like {@link composeHasHostBindMount},
 * and for the same reason: both are a container reaching past its own boundary,
 * and a permission that stops one while allowing the other stops nothing.
 *
 * Tolerant of malformed input, like its two siblings: the deploy-time parse is
 * the authoritative one.
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
 * Parse a compose YAML string and report whether ANY service publishes a port
 * on the HOST - a `ports:` entry, which binds the server's own IP and port.
 * Used server-side to gate compose edits behind the `canExposePorts` grant.
 *
 * **`expose:` is NOT publishing and is deliberately not counted.** It binds
 * nothing: it advertises a container port to the same network, which compose
 * already allows without it, and it reaches the host through no path at all.
 * Gating it charged the grant for a declaration that opens nothing, and the
 * cost was not theoretical - measured against the 517 stacks in the other
 * platform's own catalogue, 310 of them declare `expose:` while binding ZERO
 * host ports, so two thirds of a fleet could only be created or migrated by
 * someone holding an instance-wide grant. {@link composeHostPorts}, which
 * answers WHICH host ports a stack binds, always agreed: it returns `[]` for
 * every one of them. The two now say the same thing.
 *
 * This is independent of Traefik routing: giving a service a public DOMAIN does
 * not publish a port and is never gated here.
 *
 * Tolerant of malformed input: YAML it can't parse, or a doc with no services,
 * has no detectable published port (the deploy-time parse is authoritative). A
 * `ports:` key present but empty (`[]`/null) declares nothing, so it does not
 * count.
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
 * The HOST ports a compose file would bind, deduped.
 *
 * `composePublishesPorts` answers whether a stack publishes at all (the grant
 * question); this answers WHICH, for the one caller that has to say something
 * useful before anything is created: an import, where a stack carrying `80:80`
 * is about to land on a machine whose 80 belongs to the proxy and the failure
 * would otherwise arrive as an unexplained `docker compose up` error.
 *
 * Both spellings, and the range form (`8000-8005:8000-8005`) expanded, bounded
 * so a wide range cannot turn one stack into a thousand probes.
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
