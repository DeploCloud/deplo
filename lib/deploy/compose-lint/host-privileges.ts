import {
  composeTruthy,
  interpolates,
  isInterpolated,
  loadComposeDoc,
} from "./document";
import { composeJoinsForeignNetwork } from "./networks";
import {
  composeHasHostBindMount,
  composeMountsForeignStorage,
  isHostBindSource,
} from "./volumes";

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
  "gpus",
  "runtime",
  "extra_hosts",
] as const;

const SAFE_NETWORK_MODE = /^(none|default)$/i;

const SAFE_SECURITY_OPTS = /^no-new-privileges(?:[:=]\s*true)?$/i;

export function hostPrivilegeKeys(svc: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of HOST_PRIVILEGE_KEYS) {
    const v = svc[key];
    if (v == null) continue;
    if (key === "privileged" || key === "oom_kill_disable") {
      if (composeTruthy(v) || isInterpolated(v)) out.push(key);
      continue;
    }
    if (key === "oom_score_adj") {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if ((Number.isFinite(n) && n < 0) || isInterpolated(v)) out.push(key);
      continue;
    }
    if (key === "group_add") {
      if (Array.isArray(v) ? v.length > 0 : String(v).trim() !== "")
        out.push(key);
      continue;
    }
    if (key === "logging") {
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
      const risky = Object.keys(opts).some(
        (k) => !/^max-(size|file)$/i.test(k.trim()),
      );
      if (nonDefaultDriver || risky) out.push(key);
      continue;
    }
    if (key === "network_mode") {
      if (typeof v === "string" && !SAFE_NETWORK_MODE.test(v.trim()))
        out.push(key);
      continue;
    }
    if (key === "pid" || key === "ipc" || key === "uts" || key === "cgroup") {
      if (typeof v === "string") {
        const val = v.trim().toLowerCase();
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

export function composeNeedsHostPrivileges(composeYaml: string): boolean {
  return composeHostPrivilegeKeys(composeYaml).length > 0;
}

export function composeHostPrivilegeKeys(composeYaml: string): string[] {
  const doc = loadComposeDoc<{ services?: Record<string, unknown> }>(
    composeYaml,
  );
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

export function composeBuildReachesHost(composeYaml: string): boolean {
  const doc = loadComposeDoc<{ services?: Record<string, unknown> }>(
    composeYaml,
  );
  const services = doc?.services;
  if (!services || typeof services !== "object") return false;
  for (const raw of Object.values(services)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const b = (raw as Record<string, unknown>).build;
    if (b == null) continue;
    if (typeof b === "string") {
      if (isHostBindSource(b)) return true;
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

export function composeUsesExternalMerge(composeYaml: string): string | null {
  const doc = loadComposeDoc<{
    services?: Record<string, unknown>;
    include?: unknown;
  }>(composeYaml);
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

export function externalMergeMessage(key: string): string {
  return (
    `\`${key}\` merges configuration from another file, which Deplo can't inspect ` +
    `before it deploys - it could pull in host access or another team's hostname ` +
    `past the checks here. Inline what you need into this compose file instead.`
  );
}
