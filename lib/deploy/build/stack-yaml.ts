import "server-only";

import { join } from "node:path";
import yaml from "../../yaml";
import { parseMountPropagation } from "../../apps/volume-model";
import type { MountPropagation } from "../../types/container";

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const STACK_DIR = join(DATA_DIR, "stacks");

// readStackImageFromYaml reads the `image:` baked into a single-image stack YAML.
export function readStackImageFromYaml(
  stackYaml: string,
  service: string,
): string | null {
  try {
    const doc = yaml.load(stackYaml) as {
      services?: Record<string, { image?: unknown }>;
    } | null;
    const svc = doc?.services?.[service];
    return typeof svc?.image === "string" ? svc.image : null;
  } catch {
    return null;
  }
}

// readStackEnvFromYaml reads the `environment:` map baked into a single-image stack YAML.
export function readStackEnvFromYaml(
  stackYaml: string,
  service: string,
): Record<string, string> | null {
  try {
    const doc = yaml.load(stackYaml) as {
      services?: Record<string, { environment?: unknown }>;
    } | null;
    const env = doc?.services?.[service]?.environment;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        out[k] = String(v);
      }
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

// StackVolume is the shape `renderCompose` accepts and `parseStackVolumes` reconstructs.
export type StackVolume = {
  type?: "named" | "app" | "host";
  name: string;
  projectPath?: string;
  hostPath?: string;
  mountPath: string;
  readOnly?: boolean;
  propagation?: MountPropagation;
};

// readStackVolumesFromYaml reads back the mounts the container is ACTUALLY running with.
export function readStackVolumesFromYaml(
  stackYaml: string,
  service: string,
): StackVolume[] {
  try {
    return parseStackVolumes(stackYaml, service);
  } catch {
    return [];
  }
}

// parseStackPorts reads the ports the RUNNING stack publishes.
export function parseStackPorts(yamlText: string, service: string): string[] {
  try {
    const doc = yaml.load(yamlText) as {
      services?: Record<string, { ports?: unknown }>;
    } | null;
    const list = doc?.services?.[service]?.ports;
    return Array.isArray(list)
      ? list
          .filter((p): p is string | number => typeof p !== "object")
          .map(String)
      : [];
  } catch {
    return [];
  }
}

// parseStackHealthCheck reads the health check the RUNNING stack carries.
export function parseStackHealthCheck(
  yamlText: string,
  service: string,
): Record<string, unknown> | null {
  try {
    const doc = yaml.load(yamlText) as {
      services?: Record<string, { healthcheck?: unknown }>;
    } | null;
    const hc = doc?.services?.[service]?.healthcheck;
    return hc && typeof hc === "object" && !Array.isArray(hc)
      ? (hc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// parseStackVolumes is the pure parser behind `readStackVolumesFromYaml` (no fs).
export function parseStackVolumes(
  yamlText: string,
  service: string,
): StackVolume[] {
  const doc = yaml.load(yamlText) as {
    services?: Record<string, { volumes?: unknown }>;
  } | null;
  const list = doc?.services?.[service]?.volumes;
  if (!Array.isArray(list)) return [];
  const filesRoot = join(STACK_DIR, "files") + "/";
  return list.flatMap((e) => {
    if (typeof e !== "string") return [];
    const [source, mountPath, flag] = e.split(":");
    if (!source || !mountPath) return [];
    const opts = (flag ?? "").split(",");
    const readOnly = opts.includes("ro");
    const propagation = parseMountPropagation(opts);
    const prop = propagation ? { propagation } : {};
    if (source.startsWith(filesRoot)) {
      const afterRoot = source.slice(filesRoot.length);
      const slash = afterRoot.indexOf("/");
      const projectPath = slash >= 0 ? afterRoot.slice(slash + 1) : "";
      if (projectPath) {
        return [
          { type: "app" as const, name: "", projectPath, mountPath, readOnly },
        ];
      }
    }
    if (source.startsWith("/")) {
      return [
        {
          type: "host" as const,
          name: "",
          hostPath: source,
          mountPath,
          readOnly,
          ...prop,
        },
      ];
    }
    return [{ name: source, mountPath, readOnly }];
  });
}
