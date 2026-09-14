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

// Compose keys that hand a container the host. Every one is another way to where a
// `/var/run/docker.sock` bind goes - `privileged` alone mounts the host disk,
// `pid: host` puts `nsenter -t 1` one command away - so they take the same grant.
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

// The `network_mode:` values that reach nothing: no network at all, and this
// compose project's own default. Everything else is gated.
const SAFE_NETWORK_MODE = /^(none|default)$/i;

// `security_opt` entries that only ever make a container SAFER, so are not gated:
// asking for the host permission in order to HARDEN one teaches people to skip it.
const SAFE_SECURITY_OPTS = /^no-new-privileges(?:[:=]\s*true)?$/i;

// The privilege keys this service actually sets, in declaration order. A key present
// but empty declares nothing.
export function hostPrivilegeKeys(svc: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of HOST_PRIVILEGE_KEYS) {
    const v = svc[key];
    if (v == null) continue;
    if (key === "privileged" || key === "oom_kill_disable") {
      // `oom_kill_disable: true` means the kernel kills OTHER tenants' containers
      // under memory pressure instead of this one - a cross-tenant availability hit.
      if (composeTruthy(v) || isInterpolated(v)) out.push(key);
      continue;
    }
    if (key === "oom_score_adj") {
      // A NEGATIVE adjust is `oom_kill_disable` by degrees: the kernel spares this
      // container and kills its neighbours. A positive value only volunteers this
      // one first, which is safe and free.
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
      // An ALLOWLIST, because ANY value that is not a keyword is a docker NETWORK
      // NAME: `network_mode: deplo-env-<id>` attaches the container to another
      // Environment's network, with DNS, and no `networks:` key for anything to see.
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
      // `container:<name>` names a container OUTSIDE this stack (another tenant's,
      // or the platform's) - the escape; a bare service name is same-stack.
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
      // file on the SERVER, a relative name reads the stack's own. `env_file: - .env`
      // is the commonest env pattern there is, and gating it gated the whole feature.
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
      // Only the device reservations: `deploy.resources.limits` is the ordinary way
      // to cap a service and must stay free. Named in full, because a refusal saying
      // `deploy` sends the reader looking at the wrong key.
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

// Whether ANY service asks for host privileges, gated behind `canMountHostVolumes`
// like its two siblings. Tolerant of malformed input.
export function composeNeedsHostPrivileges(composeYaml: string): boolean {
  return composeHostPrivilegeKeys(composeYaml).length > 0;
}

// The privilege keys this whole file sets, deduped and in declaration order, so a
// refusal can name what tripped it instead of guessing at a bind mount.
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

// What in this compose reaches PAST the container, in words. One list, so the gate,
// the import preview and the refusal can never name it differently.
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

// Whether any service's `build:` reaches a host path the app does not own - an
// absolute or `..`-escaping context/dockerfile, an `additional_contexts` source, an
// `ssh:` key, or a privileged build. Same host reach as a bind, same grant.
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

// The first compose key that MERGES config from a file the save-time detectors
// cannot see (`extends: {file:}`, top-level `include:`, `label_file:`), or null.
// Compose resolves them on the host, so what they pull in never reaches a gate.
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

// The message the editor and the save both use for an external-merge key.
export function externalMergeMessage(key: string): string {
  return (
    `\`${key}\` merges configuration from another file, which Deplo can't inspect ` +
    `before it deploys - it could pull in host access or another team's hostname ` +
    `past the checks here. Inline what you need into this compose file instead.`
  );
}
