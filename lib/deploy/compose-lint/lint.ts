import yaml from "../../yaml";

import { interpolates } from "./document";
import { isValidPortMapping, unboundDnsPort } from "./host-ports";
import {
  composeBuildReachesHost,
  composeUsesExternalMerge,
  externalMergeMessage,
  hostPrivilegeKeys,
} from "./host-privileges";
import { composeJoinsForeignNetwork, serviceReservedClaim } from "./networks";
import {
  fileSourcedKeys,
  foreignVolumeKeys,
  isEscapingSource,
  isFilesConventionSource,
  volumeSource,
} from "./volumes";

export type LintSeverity = "error" | "warning" | "info";

export const HOST_ACCESS_RULES: readonly string[] = [
  "host-privileges",
  "foreign-volume",
  "bind-mount-absolute",
  "bind-mount-escapes-sandbox",
  "bind-mount-interpolated",
];

export function needsHostAccess(
  diagnostics: readonly { rule: string }[],
): boolean {
  return diagnostics.some((d) => HOST_ACCESS_RULES.includes(d.rule));
}

export interface LintDiagnostic {
  severity: LintSeverity;
  message: string;
  rule: string;
  line: number;
  column?: number;
}

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

function lineOfAppKey(lines: string[], service: string): number {
  const re = new RegExp(`^\\s+${escapeRe(service)}\\s*:\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}

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

function lineOfServiceField(
  lines: string[],
  appLine: number,
  field: string,
): number {
  const startIdx = appLine - 1;
  const appIndent = leadingSpaces(lines[startIdx] ?? "");
  const re = new RegExp(`^(\\s+)${escapeRe(field)}\\s*:`);
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = leadingSpaces(line);
    if (indent <= appIndent) break;
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

  let doc: ComposeDoc;
  try {
    doc = (yaml.load(source) as ComposeDoc) ?? {};
  } catch (e) {
    const mark = markOf(e);
    const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
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

  if ("version" in doc) {
    diags.push({
      severity: "warning",
      rule: "obsolete-version",
      message:
        "`version` is obsolete in Compose v2 and is ignored. You can remove it.",
      line: lineOfTopKey(lines, "version"),
    });
  }

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

    const reservedClaim = serviceReservedClaim(name, svc);
    if (reservedClaim) {
      diags.push({
        severity: "warning",
        rule: "reserved-service-name",
        message: `\`${reservedClaim}\` is a name Deplo's own infrastructure uses. This service cannot be given a domain under it - rename it if it needs one.`,
        line: svcLine,
      });
    }

    if (svcNetworkAliases(svc).length > 0) {
      diags.push({
        severity: "warning",
        rule: "network-aliases-dropped",
        message: `\`${name}\` sets network aliases. Deplo removes them - other services reach it by its service name.`,
        line: lineOfServiceField(lines, svcLine, "networks"),
      });
    }

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
          } else if (unboundDnsPort(p)) {
            diags.push({
              severity: "warning",
              rule: "dns-port-unbound",
              message: `\`${name}.ports\` publishes 53 on every address, which takes over this machine's own DNS and stops other apps resolving anything. Bind it to the public address: "203.0.113.10:53:53/udp".`,
              line: portsLine,
            });
          }
        }
      }
    }

    checkListOrMap(svc, "environment", name, svcLine, lines, diags);
    checkList(svc, "volumes", name, svcLine, lines, diags);
    checkListOrMap(svc, "networks", name, svcLine, lines, diags);
    checkListOrMap(svc, "labels", name, svcLine, lines, diags);

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

    if (Array.isArray(svc.volumes)) {
      const volLine = lineOfServiceField(lines, svcLine, "volumes");
      for (const v of svc.volumes) {
        const src = volumeSource(v);
        if (!src) continue;
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

    if ("container_name" in svc) {
      diags.push({
        severity: "info",
        rule: "container-name-stripped",
        message: `Deplo strips \`container_name\` (it would collide between services); \`${name}\` will use Compose's generated name.`,
        line: lineOfServiceField(lines, svcLine, "container_name"),
      });
    }

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

    if ("network_mode" in svc && "networks" in svc && svc.networks != null) {
      diags.push({
        severity: "warning",
        rule: "network-mode-conflict",
        message: `\`${name}\` sets both \`network_mode\` and \`networks\` - Compose forbids combining them, and Deplo needs \`networks\` to attach the stack's own network.`,
        line: lineOfServiceField(lines, svcLine, "network_mode"),
      });
    }

    for (const key of hostPrivilegeKeys(svc)) {
      diags.push({
        severity: "warning",
        rule: "host-privileges",
        message: `\`${name}\` sets \`${key}\`, which takes the container out of its sandbox and gives it access to the server itself. This needs the host-volume permission.`,
        line: lineOfServiceField(lines, svcLine, key),
      });
    }
  }

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

  const merge = composeUsesExternalMerge(source);
  if (merge) {
    diags.push({
      severity: "error",
      rule: "external-merge",
      message: externalMergeMessage(merge),
      line: merge === "include" ? lineOfTopKey(lines, "include") : 1,
    });
  }
  if (composeJoinsForeignNetwork(source)) {
    diags.push({
      severity: "warning",
      rule: "foreign-network",
      message:
        "A service here joins a network this app doesn't own (an existing network by name, or one bridged onto the server). That reaches other stacks' private services. This needs the host-volume permission.",
      line: lineOfTopKey(lines, "networks"),
    });
  }
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

export function hasBlockingErrors(diags: LintDiagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}

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

function hasExplicitTagOrDigest(image: string): boolean {
  if (image.includes("@")) return true;
  const lastSlash = image.lastIndexOf("/");
  const lastComponent = lastSlash === -1 ? image : image.slice(lastSlash + 1);
  return lastComponent.includes(":");
}

function stringifyPort(p: unknown): string {
  if (typeof p === "string" || typeof p === "number") return String(p);
  return JSON.stringify(p);
}

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
