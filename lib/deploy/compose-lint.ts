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
function lineOfServiceKey(lines: string[], service: string): number {
  // Service keys are indented under `services:` — typically 2 spaces. Match a
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
  serviceLine: number,
  field: string,
): number {
  // Scan from the service line until indentation returns to the service's level
  // or shallower (next service / top-level), looking for `field:`.
  const startIdx = serviceLine - 1;
  const serviceIndent = leadingSpaces(lines[startIdx] ?? "");
  const re = new RegExp(`^(\\s+)${escapeRe(field)}\\s*:`);
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = leadingSpaces(line);
    if (indent <= serviceIndent) break; // left the service block
    const m = line.match(re);
    if (m && m[1].length > serviceIndent) return i + 1;
  }
  return serviceLine;
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
  const serviceEntries = Object.entries(services as Record<string, unknown>);
  if (serviceEntries.length === 0) {
    diags.push({
      severity: "error",
      rule: "empty-services",
      message: "`services:` is empty. Add at least one service.",
      line: lineOfTopKey(lines, "services"),
    });
    return sortDiags(diags);
  }

  // 5. Per-service checks.
  for (const [name, raw] of serviceEntries) {
    const svcLine = lineOfServiceKey(lines, name);

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      diags.push({
        severity: "error",
        rule: "service-shape",
        message: `Service \`${name}\` must be a mapping (image, ports, environment, …).`,
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
        message: `Service \`${name}\` has neither \`image:\` nor \`build:\`. It cannot start.`,
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
    // networks: list or mapping. Load-bearing — Deplo's serviceNetworks() reads
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
      const known = new Set(serviceEntries.map(([n]) => n));
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

    // Bind mounts: note the `../files` convention and warn on absolute host paths.
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
        } else if (src.startsWith("/")) {
          diags.push({
            severity: "warning",
            rule: "bind-mount-absolute",
            message: `\`${name}\` bind-mounts host path \`${src}\` — it must exist on the deploy host and isn't isolated per project. Prefer a named volume.`,
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
        message: `Deplo strips \`container_name\` (it would collide between projects); \`${name}\` will use Compose's generated name.`,
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

    // privileged is a security smell.
    if (svc.privileged === true) {
      diags.push({
        severity: "warning",
        rule: "privileged",
        message: `\`${name}\` runs \`privileged: true\` — it gains full host access. Avoid unless strictly required.`,
        line: lineOfServiceField(lines, svcLine, "privileged"),
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

/** The `../files/<x>` convention is rewritten to the project's isolated files
 * directory at deploy time — NOT a host bind mount the user picked a path for. */
function isFilesConventionSource(src: string): boolean {
  return /^(?:\.\.?\/)*files\//.test(src);
}

/**
 * True if a single compose volume entry bind-mounts a real HOST path — i.e. an
 * absolute source that is NOT the project-isolated `../files/...` convention.
 * Shared by the editor lint (warning) and the server-side permission gate so
 * the two never disagree about what counts as a host mount.
 */
export function isHostBindSource(src: string | null | undefined): boolean {
  return Boolean(src && src.startsWith("/") && !isFilesConventionSource(src));
}

/** A docker-compose document, just the slice we read for host-bind detection. */
interface ComposeDocShape {
  services?: Record<string, { volumes?: unknown } | null | undefined>;
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
